/**
 * Checkout: the moment a cart (a wish) becomes an order (a commitment).
 *
 * The sequence matters and is deliberately rigid:
 *
 *   1. Re-price the cart against LIVE variant prices — never trust the
 *      snapshot the customer has been looking at for the last twenty minutes.
 *   2. Reserve inventory for every line, ATOMICALLY, inside the same
 *      transaction that creates the order. All lines succeed or none do.
 *   3. Create the Order + OrderLines with prices snapshotted onto them —
 *      permanently, this time. An invoice must not change if the catalogue
 *      does.
 *   4. Mark the cart CONVERTED.
 *   5. COMMIT.
 *   6. Only after the commit, start the SantimPay payment (outside the
 *      transaction — an external HTTP call has no place inside a database
 *      transaction; it would hold locks for the duration of a network round
 *      trip to a third party).
 *
 * If step 6 fails, the order already exists in PENDING_PAYMENT with its stock
 * reserved: the customer can retry payment on the same order, and
 * `startPayment`'s reuse-in-flight-intent logic (payment-service.ts) picks it
 * back up rather than double-booking anything.
 */

import { prisma } from "../db.js";
import { logger } from "../observability/logger.js";
import { generateOrderNumber } from "../orders/order-number.js";
import { InsufficientStockError, reserveForOrder, type ReserveLine } from "../inventory/reservation.js";
import { cartSubtotalSantim, priceCartLines, type CartLineLike } from "../cart/cart-service.js";
import { ordersPlacedTotal } from "../observability/metrics.js";
import { normalizeEthiopianMsisdn, PhoneNumberError, santim } from "@santim/santimpay";
import { env } from "../config/env.js";
import { startPayment, type StartPaymentResult } from "../payments/payment-service.js";
import { calculateShipping, type ShippingZone } from "../pricing/shipping-service.js";
import { calculateTax } from "../pricing/tax-service.js";
import { redeemCoupon, CouponError } from "../promotions/coupon-service.js";

export class CheckoutError extends Error {
  override name = "CheckoutError";
}

export class PriceChangedError extends CheckoutError {
  override name = "PriceChangedError";
  readonly changedVariantIds: string[];
  constructor(changedVariantIds: string[]) {
    super(
      `Prices changed for ${changedVariantIds.length} item(s) since they were added to the cart. Review and confirm before paying.`,
    );
    this.changedVariantIds = changedVariantIds;
  }
}

export class EmptyCartError extends CheckoutError {
  override name = "EmptyCartError";
  constructor() {
    super("Cannot check out an empty cart");
  }
}

export interface PlaceOrderInput {
  readonly cartToken: string;
  readonly email: string;
  readonly phone: string;
  readonly userId?: string | null;
  /** Drives the shipping rate — see pricing/shipping-service.ts for why this is a fixed zone, not a free-text city. */
  readonly shippingZone: ShippingZone;
  readonly shippingAddress?: Record<string, unknown>;
  readonly billingAddress?: Record<string, unknown>;
  readonly customerNote?: string;
  /**
   * Customer has seen and accepted the re-priced total. Set after a first
   * call threw PriceChangedError and the UI showed the new prices. Without
   * this, a price increase would otherwise be charged silently.
   */
  readonly acceptPriceChanges?: boolean;
  /**
   * Requires a signed-in customer (`userId` set) — the per-user "one
   * redemption" rule (coupon-service.ts's `@@unique([couponId, userId])`)
   * has nothing to key on for a guest. `submitCheckout` should disable the
   * coupon field for guests rather than let this throw at submit time, but
   * the check here is what actually protects it either way.
   */
  readonly couponCode?: string;
}

export interface PlaceOrderResult {
  readonly orderId: string;
  readonly orderNumber: string;
  readonly totalSantim: number;
}

export async function placeOrder(input: PlaceOrderInput): Promise<PlaceOrderResult> {
  if (input.couponCode && !input.userId) {
    throw new CheckoutError("Sign in to use a coupon code.");
  }

  let phone: string;
  try {
    phone = normalizeEthiopianMsisdn(input.phone);
  } catch (error) {
    if (error instanceof PhoneNumberError) {
      throw new CheckoutError(`Phone number invalid: ${error.message}`);
    }
    throw error;
  }

  const cart = await prisma.cart.findUnique({
    where: { token: input.cartToken },
    include: {
      lines: { include: { variant: { include: { product: { include: { seller: true } }, inventory: true } } } },
    },
  });

  if (!cart || cart.status !== "ACTIVE" || cart.lines.length === 0) {
    throw new EmptyCartError();
  }

  const priced = priceCartLines(cart.lines as unknown as CartLineLike[]);
  const changed = priced.filter((l) => l.priceChanged);
  if (changed.length > 0 && !input.acceptPriceChanges) {
    throw new PriceChangedError(changed.map((l) => l.variantId));
  }

  for (const line of cart.lines) {
    // Re-checked here, not just at add-to-cart: a seller can be suspended
    // (or a listing unpublished) in the window between "added to cart" and
    // "checkout" — the master mandate's own "seller becomes unavailable"
    // edge case. Same reasoning as the price-change re-check just above.
    if (
      !line.variant.active ||
      line.variant.product.status !== "ACTIVE" ||
      line.variant.product.seller.status !== "APPROVED"
    ) {
      throw new CheckoutError(`"${line.variant.title}" is no longer available`);
    }
  }

  const subtotalSantim = cartSubtotalSantim(priced);
  // Free-shipping-threshold eligibility is evaluated on the GOODS subtotal
  // before any coupon discount — it's a merchandise-value threshold ("spend
  // X, ship free"), not something a discount code should also unlock.
  const shippingSantim = calculateShipping(input.shippingZone, santim(subtotalSantim));

  const orderNumber = await generateUniqueOrderNumber();

  const reserveLines: ReserveLine[] = cart.lines.map((l) => ({
    variantId: l.variantId,
    quantity: l.quantity,
  }));

  const reservationTtlMinutes = env().RESERVATION_TTL_MINUTES;
  const expiresAt = new Date(Date.now() + reservationTtlMinutes * 60_000);

  try {
    const order = await prisma.$transaction(async (tx) => {
      // Coupon redemption happens first, inside the transaction: it needs
      // to atomically reserve a limited coupon's last use (see
      // coupon-service.ts's module comment), and if it throws, the whole
      // transaction — order, lines, reservation — must never have existed.
      let discountSantim = 0;
      let redeemedCouponId: string | null = null;
      if (input.couponCode) {
        // input.userId is guaranteed non-null here — checked at the top of
        // placeOrder before any DB work starts.
        const couponCartLines = cart.lines.map((l) => ({
          sellerId: l.variant.product.sellerId,
          lineTotalSantim: l.variant.priceSantim * l.quantity,
        }));
        const redeemed = await redeemCoupon(tx, input.couponCode, input.userId as string, couponCartLines);
        discountSantim = redeemed.discountSantim;
        redeemedCouponId = redeemed.couponId;
      }

      // VAT is computed on the GOODS subtotal net of any coupon discount —
      // that's the amount actually being sold for. Whether Ethiopian VAT
      // also applies to the shipping charge itself is a separate, real
      // question for an accountant, not something to assume silently — see
      // tax-service.ts's module comment. Get that confirmed before this
      // figure is load-bearing for a real tax filing.
      const taxableSantim = subtotalSantim - discountSantim;
      const taxSantim = calculateTax(santim(taxableSantim));
      const totalSantim = taxableSantim + shippingSantim + taxSantim;

      const created = await tx.order.create({
        data: {
          orderNumber,
          userId: input.userId ?? cart.userId ?? null,
          email: input.email,
          phone,
          status: "PENDING_PAYMENT",
          subtotalSantim,
          discountSantim,
          shippingSantim,
          taxSantim,
          totalSantim,
          shippingAddress: input.shippingAddress as object | undefined,
          billingAddress: input.billingAddress as object | undefined,
          customerNote: input.customerNote,
          lines: {
            create: cart.lines.map((line) => ({
              variantId: line.variantId,
              sellerId: line.variant.product.sellerId,
              sku: line.variant.sku,
              productTitle: line.variant.product.title,
              variantTitle: line.variant.title,
              imageUrl: line.variant.product.heroImage,
              unitPriceSantim: line.variant.priceSantim,
              quantity: line.quantity,
              lineTotalSantim: line.variant.priceSantim * line.quantity,
              // Snapshotted for real margin reporting — see OrderLine's
              // own schema comment on why this must never be a live
              // read of the variant's CURRENT cost.
              costSantim: line.variant.costSantim,
            })),
          },
        },
      });

      if (redeemedCouponId) {
        // The real backstop against a same-user double-redemption race — see
        // coupon-service.ts's module comment. A P2002 here rolls back this
        // entire transaction, including the redemptionsRemaining decrement
        // above, so a failed checkout never permanently burns a coupon use.
        await tx.couponRedemption.create({
          data: {
            couponId: redeemedCouponId,
            userId: input.userId as string,
            orderId: created.id,
            discountSantim,
          },
        });
      }

      // Reservation happens INSIDE this transaction. If any line is out of
      // stock, `reserveForOrder` throws, the whole transaction — order,
      // lines, and any partial reservations — rolls back atomically. No
      // "order created but nothing reserved" state can ever be observed.
      await reserveForOrder(tx, created.id, reserveLines, expiresAt);

      await tx.cart.update({ where: { id: cart.id }, data: { status: "CONVERTED" } });

      await tx.orderEvent.create({
        data: {
          orderId: created.id,
          type: "order.placed",
          message: `Order placed with ${cart.lines.length} line(s), reserved until ${expiresAt.toISOString()}`,
          actor: input.userId ?? "guest",
        },
      });

      return created;
    });

    logger.info("checkout.order_placed", { orderId: order.id, orderNumber, totalSantim: order.totalSantim });
    ordersPlacedTotal.inc();
    return { orderId: order.id, orderNumber, totalSantim: order.totalSantim };
  } catch (error) {
    if (error instanceof CouponError) {
      throw new CheckoutError(error.message);
    }
    if (error instanceof InsufficientStockError) {
      logger.warn("checkout.insufficient_stock", {
        cartId: cart.id,
        variantId: error.variantId,
        requested: error.requested,
      });
      throw new CheckoutError(
        `"${cart.lines.find((l) => l.variantId === error.variantId)?.variant.title ?? error.variantId}" ` +
          `no longer has enough stock. Please update your cart.`,
      );
    }
    throw error;
  }
}

/**
 * Convenience wrapper: place the order, then immediately start the SantimPay
 * checkout session. Split into two functions rather than one so that server
 * actions / API routes can show "order placed" before redirecting to payment,
 * and so retries after a payment-initiation failure don't re-run the
 * inventory reservation.
 */
export async function placeOrderAndStartPayment(
  input: PlaceOrderInput,
): Promise<PlaceOrderResult & StartPaymentResult> {
  const order = await placeOrder(input);
  const payment = await startPayment(order.orderId);
  return { ...order, ...payment };
}

async function generateUniqueOrderNumber(): Promise<string> {
  // Collisions are astronomically unlikely (32^8 keyspace) but a payments
  // system does not get to shrug at "astronomically unlikely" — it retries
  // against the actual unique constraint instead of trusting the odds.
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateOrderNumber();
    const exists = await prisma.order.findUnique({ where: { orderNumber: candidate } });
    if (!exists) return candidate;
  }
  throw new CheckoutError("Could not allocate a unique order number after 5 attempts");
}
