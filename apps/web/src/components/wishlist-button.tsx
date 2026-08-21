"use client";

import { useActionState, useEffect, useState } from "react";
import { toggleWishlistAction, type WishlistActionState } from "@/server/actions/wishlist-actions";

const INITIAL_STATE: WishlistActionState = { ok: false };

export function WishlistButton({
  productId,
  productSlug,
  initialWishlisted,
  compact = false,
}: {
  productId: string;
  productSlug: string;
  initialWishlisted: boolean;
  /** Icon-only, for a grid-card overlay — no "Save"/"Saved" label, no inline error text. */
  compact?: boolean;
}) {
  const [state, formAction, pending] = useActionState(toggleWishlistAction, INITIAL_STATE);
  // Optimistic-ish local mirror of the server's real answer — starts from
  // the real initial value computed server-side, then follows whatever the
  // action actually persisted, never a client-only guess.
  const [wishlisted, setWishlisted] = useState(initialWishlisted);

  useEffect(() => {
    if (state.ok && state.wishlisted !== undefined) setWishlisted(state.wishlisted);
  }, [state]);

  return (
    <form
      action={formAction}
      className={compact ? "wishlist-button-form wishlist-button-form--compact" : "wishlist-button-form"}
      // A grid card's own media/body are separate <Link>s around this form
      // (siblings, never nesting a <form> inside an <a>) — but the form
      // still sits visually on top of the image, so a click must not also
      // trigger whichever Link happens to be underneath it.
      onClick={(e) => e.stopPropagation()}
    >
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="productSlug" value={productSlug} />
      <button
        type="submit"
        className={compact ? "wishlist-button wishlist-button--compact" : "wishlist-button"}
        aria-pressed={wishlisted}
        aria-label={wishlisted ? "Remove from wishlist" : "Save to wishlist"}
        disabled={pending}
      >
        <svg width={compact ? 16 : 20} height={compact ? 16 : 20} viewBox="0 0 24 24" fill={wishlisted ? "currentColor" : "none"} aria-hidden="true">
          <path
            d="M12 20.5s-7.5-4.6-10-9.1C0.5 8.2 2 4.5 5.5 4c2.1-.3 4 .8 6.5 3.3C14.5 4.8 16.4 3.7 18.5 4c3.5.5 5 4.2 3.5 7.4-2.5 4.5-10 9.1-10 9.1Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
        {!compact && (wishlisted ? "Saved" : "Save")}
      </button>
      {!compact && state.message && !state.ok && (
        <p className="alert alert--error" style={{ marginTop: "var(--space-2)" }}>{state.message}</p>
      )}
    </form>
  );
}
