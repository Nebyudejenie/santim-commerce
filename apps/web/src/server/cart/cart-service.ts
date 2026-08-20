/**
 * Cart service.
 *
 * Two rules worth stating up front because they are easy to get wrong:
 *
 *  1. GUESTS ARE FIRST-CLASS. A cart is identified by an opaque, unguessable
 *     `token` stored in an httpOnly cookie — never by session or user id alone.
 *     Forcing login before "add to cart" is a proven conversion killer, and it
 *     also means the cart has to be re-architected the day someone asks for
 *     guest checkout. Design for it from the start; merge into the user's cart
 *     at login instead.
 *
 *  2. PRICE IS SNAPSHOTTED AT ADD-TIME, RE-CHECKED AT CHECKOUT. Storing only a
 *     `variantId` and reading the live price at render time means a mid-cart
 *     price change silently changes what the customer thought they agreed to
 *     pay. Snapshotting lets us instead show "this went up 20 birr since you
 *     added it" — an honest UI is not optional for a payments product.
 */

import crypto from "node:crypto";
import { prisma } from "../db.js";
import { logger } from "../observability/logger.js";

export class CartError extends Error {
  override name = "CartError";
}

export class VariantUnavailableError extends CartError {
  override name = "VariantUnavailableError";
  readonly variantId: string;
  constructor(variantId: string) {
    super(`Variant ${variantId} is not available for purchase`);
    this.variantId = variantId;
  }
}

/** Opaque, unguessable — this token is a bearer credential for the cart. */
export function generateCartToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

const CART_TTL_DAYS = 30;

export async function getOrCreateCart(token: string | undefined, userId: string | null) {
  if (token) {
    const existing = await prisma.cart.findUnique({
      where: { token },
      include: { lines: { include: { variant: { include: { product: true, inventory: true } } } } },
    });
    if (existing && existing.status === "ACTIVE") {
      // A guest cart becomes the logged-in user's cart the moment they
      // authenticate, rather than being abandoned in favour of an empty one.
      if (userId && existing.userId !== userId) {
        return prisma.cart.update({
          where: { id: existing.id },
          data: { userId },
          include: { lines: { include: { variant: { include: { product: true, inventory: true } } } } },
        });
      }
      return existing;
    }
  }

  const created = await prisma.cart.create({
    data: {
      token: token ?? generateCartToken(),
      userId,
      expiresAt: new Date(Date.now() + CART_TTL_DAYS * 24 * 60 * 60 * 1000),
    },
    include: { lines: { include: { variant: { include: { product: true, inventory: true } } } } },
  });
  return created;
}

export interface AddLineInput {
  readonly cartToken: string;
  readonly variantId: string;
  readonly quantity: number;
}

export async function addLine(input: AddLineInput) {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new CartError(`quantity must be a positive integer, got ${input.quantity}`);
  }

  const variant = await prisma.variant.findUnique({
    where: { id: input.variantId },
    include: { product: { include: { seller: true } } },
  });

  if (
    !variant ||
    !variant.active ||
    variant.product.status !== "ACTIVE" ||
    variant.product.seller.status !== "APPROVED"
  ) {
    throw new VariantUnavailableError(input.variantId);
  }

  const cart = await getOrCreateCart(input.cartToken, null);

  // Upsert on the (cartId, variantId) unique constraint: adding an item
  // already in the cart increases quantity rather than creating a duplicate
  // line, which is what the unique constraint in the schema exists to enforce
  // even if this code ever has a bug.
  const line = await prisma.cartLine.upsert({
    where: { cartId_variantId: { cartId: cart.id, variantId: input.variantId } },
    create: {
      cartId: cart.id,
      variantId: input.variantId,
      quantity: input.quantity,
      unitPriceSantim: variant.priceSantim,
    },
    update: {
      quantity: { increment: input.quantity },
    },
  });

  await prisma.cart.update({ where: { id: cart.id }, data: { updatedAt: new Date() } });

  logger.info("cart.line_added", { cartId: cart.id, variantId: input.variantId, quantity: input.quantity });
  return line;
}

export async function updateLineQuantity(cartToken: string, variantId: string, quantity: number) {
  const cart = await prisma.cart.findUnique({ where: { token: cartToken } });
  if (!cart) throw new CartError("cart not found");

  if (quantity <= 0) {
    await prisma.cartLine.deleteMany({ where: { cartId: cart.id, variantId } });
    return null;
  }

  return prisma.cartLine.update({
    where: { cartId_variantId: { cartId: cart.id, variantId } },
    data: { quantity },
  });
}

export async function removeLine(cartToken: string, variantId: string): Promise<void> {
  const cart = await prisma.cart.findUnique({ where: { token: cartToken } });
  if (!cart) return;
  await prisma.cartLine.deleteMany({ where: { cartId: cart.id, variantId } });
}

/**
 * Merge a guest cart into a user's cart at login — the real version of the
 * "guests are first-class" promise in this module's header comment.
 *
 * `getOrCreateCart`'s reassignment above handles the simple case (a first
 * cart, no prior history). It does NOT handle a RETURNING customer who
 * already has their own persistent cart from a previous session: blindly
 * reassigning the current guest cart's `userId` in that case would leave the
 * user with two active carts, one of them orphaned and invisible to them.
 * This function is the one login/register actually call.
 *
 * Line quantities ADD (not replace) on overlap — the guest added 2 of a
 * shirt just now, their saved cart already had 1, they see 3. Reducing to
 * whichever cart "wins" would silently drop items the customer put there on
 * purpose in the other session.
 */
export async function mergeGuestCartIntoUser(guestToken: string | undefined, userId: string): Promise<string> {
  const existingUserCart = await prisma.cart.findFirst({
    where: { userId, status: "ACTIVE" },
    include: { lines: true },
  });

  const guestCart = guestToken
    ? await prisma.cart.findUnique({ where: { token: guestToken }, include: { lines: true } })
    : null;

  // No guest cart at all, or it's already this user's own cart (re-login
  // with the same browser) — nothing to merge.
  if (!guestCart || guestCart.status !== "ACTIVE" || guestCart.userId === userId) {
    if (existingUserCart) return existingUserCart.token;
    if (guestCart) return guestCart.token; // already theirs
    const created = await getOrCreateCart(undefined, userId);
    return created.token;
  }

  if (!existingUserCart) {
    // Simple case: claim the guest cart outright.
    const updated = await prisma.cart.update({ where: { id: guestCart.id }, data: { userId } });
    return updated.token;
  }

  // Both exist: fold guest lines into the persistent cart, quantity-summed.
  await prisma.$transaction(async (tx) => {
    for (const line of guestCart.lines) {
      await tx.cartLine.upsert({
        where: { cartId_variantId: { cartId: existingUserCart.id, variantId: line.variantId } },
        create: {
          cartId: existingUserCart.id,
          variantId: line.variantId,
          quantity: line.quantity,
          unitPriceSantim: line.unitPriceSantim,
        },
        update: { quantity: { increment: line.quantity } },
      });
    }
    // Not deleted: preserved for order history / analytics continuity, the
    // same reasoning WebhookEvent rows are never deleted after processing.
    await tx.cart.update({ where: { id: guestCart.id }, data: { status: "ABANDONED" } });
  });

  logger.info("cart.merged", { userId, guestCartId: guestCart.id, userCartId: existingUserCart.id });
  return existingUserCart.token;
}

/* -------------------------------------------------------------------------
 * Pure pricing helpers — no I/O, exhaustively unit-testable.
 * ---------------------------------------------------------------------- */

export interface PricedLine {
  readonly variantId: string;
  readonly quantity: number;
  readonly snapshotPriceSantim: number;
  readonly currentPriceSantim: number;
  readonly priceChanged: boolean;
  readonly lineTotalSantim: number;
}

export interface CartLineLike {
  variantId: string;
  quantity: number;
  unitPriceSantim: number;
  variant: { priceSantim: number; active: boolean; product: { status: string } };
}

/**
 * Compare snapshotted vs. live price for every line. Used both to render
 * "price changed" banners in the cart UI and to gate checkout — see
 * `checkout-service.ts`, which refuses to proceed while any line disagrees.
 */
export function priceCartLines(lines: readonly CartLineLike[]): PricedLine[] {
  return lines.map((line) => {
    const current = line.variant.priceSantim;
    return {
      variantId: line.variantId,
      quantity: line.quantity,
      snapshotPriceSantim: line.unitPriceSantim,
      currentPriceSantim: current,
      priceChanged: current !== line.unitPriceSantim,
      lineTotalSantim: current * line.quantity,
    };
  });
}

export function cartSubtotalSantim(lines: readonly PricedLine[]): number {
  return lines.reduce((sum, l) => sum + l.lineTotalSantim, 0);
}
