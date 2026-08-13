"use server";

/**
 * Server Actions for cart mutations.
 *
 * Using Server Actions instead of a REST layer here is a deliberate choice,
 * not a default: cart mutations are same-origin, form-shaped, and need no
 * independent client (no mobile app calls this). A public API would be
 * over-engineering for a need that doesn't exist yet. The webhook and order
 * status endpoints ARE real HTTP routes (see app/api/*) because those DO have
 * independent callers — SantimPay's servers and this app's own polling client.
 */

import { revalidatePath } from "next/cache";
import { prisma } from "../db.js";
import { addLine, removeLine, updateLineQuantity, VariantUnavailableError } from "../cart/cart-service.js";
import { ensureCartToken, readCartToken } from "../cart/cart-cookie.js";
import { logger } from "../observability/logger.js";

export interface CartActionState {
  readonly ok: boolean;
  readonly error?: string;
}

export async function addToCartAction(
  _prev: CartActionState,
  formData: FormData,
): Promise<CartActionState> {
  const variantId = String(formData.get("variantId") ?? "");
  const quantity = Number(formData.get("quantity") ?? "1");

  if (!variantId) return { ok: false, error: "Choose a size before adding to your bag." };

  try {
    const token = await ensureCartToken();
    await addLine({ cartToken: token, variantId, quantity: Number.isFinite(quantity) ? quantity : 1 });
  } catch (error) {
    if (error instanceof VariantUnavailableError) {
      return { ok: false, error: "This item is no longer available." };
    }
    logger.error("cart.add_failed", { error: (error as Error).message, variantId });
    return { ok: false, error: "Couldn't add that to your bag. Please try again." };
  }

  revalidatePath("/cart");
  revalidatePath("/", "layout"); // refresh the cart count in the header
  return { ok: true };
}

export async function updateQuantityAction(formData: FormData): Promise<void> {
  const token = await ensureCartToken();
  const variantId = String(formData.get("variantId") ?? "");
  const quantity = Number(formData.get("quantity") ?? "0");
  if (!variantId) return;

  await updateLineQuantity(token, variantId, Number.isFinite(quantity) ? quantity : 0);
  revalidatePath("/cart");
  revalidatePath("/", "layout");
}

export async function removeLineAction(formData: FormData): Promise<void> {
  const token = await ensureCartToken();
  const variantId = String(formData.get("variantId") ?? "");
  if (!variantId) return;

  await removeLine(token, variantId);
  revalidatePath("/cart");
  revalidatePath("/", "layout");
}

/**
 * +/- stepper actions that don't require client JS to compute the next
 * quantity: they read the current line and adjust by one, server-side. A
 * plain <button formAction={...}> works with zero JavaScript; React still
 * upgrades it to a smooth, no-full-reload transition when JS is present.
 */
export async function incrementLineAction(formData: FormData): Promise<void> {
  await stepLine(formData, 1);
}

export async function decrementLineAction(formData: FormData): Promise<void> {
  await stepLine(formData, -1);
}

async function stepLine(formData: FormData, delta: 1 | -1): Promise<void> {
  const token = await readCartToken();
  const variantId = String(formData.get("variantId") ?? "");
  if (!token || !variantId) return;

  const cart = await prisma.cart.findUnique({ where: { token } });
  if (!cart) return;

  const line = await prisma.cartLine.findUnique({
    where: { cartId_variantId: { cartId: cart.id, variantId } },
  });
  if (!line) return;

  await updateLineQuantity(token, variantId, line.quantity + delta);
  revalidatePath("/cart");
  revalidatePath("/", "layout");
}
