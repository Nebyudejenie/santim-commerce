"use server";

/**
 * Wishlist mutations — checks its own authorization via requireUser, same
 * in-action-auth discipline as every other action in this codebase.
 */

import { revalidatePath } from "next/cache";
import { requireUser } from "../auth/guard.js";
import { toggleWishlist } from "../wishlist/wishlist-service.js";
import { logger } from "../observability/logger.js";

export interface WishlistActionState {
  readonly ok: boolean;
  readonly wishlisted?: boolean;
  readonly message?: string;
}

export async function toggleWishlistAction(
  _prev: WishlistActionState,
  formData: FormData,
): Promise<WishlistActionState> {
  const user = await requireUser();
  const productId = String(formData.get("productId") ?? "");
  const productSlug = String(formData.get("productSlug") ?? "");
  if (!productId) return { ok: false, message: "Missing product id." };

  try {
    const result = await toggleWishlist(user.id, productId);
    if (productSlug) revalidatePath(`/products/${productSlug}`);
    revalidatePath("/account/wishlist");
    return { ok: true, wishlisted: result.wishlisted };
  } catch (error) {
    logger.error("wishlist.toggle_action_failed", { userId: user.id, productId, error: (error as Error).message });
    return { ok: false, message: "Something went wrong. Please try again." };
  }
}
