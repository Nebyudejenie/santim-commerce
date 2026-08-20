"use client";

import { useActionState, useEffect, useState } from "react";
import { toggleWishlistAction, type WishlistActionState } from "@/server/actions/wishlist-actions";

const INITIAL_STATE: WishlistActionState = { ok: false };

export function WishlistButton({
  productId,
  productSlug,
  initialWishlisted,
}: {
  productId: string;
  productSlug: string;
  initialWishlisted: boolean;
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
    <form action={formAction}>
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="productSlug" value={productSlug} />
      <button
        type="submit"
        className="wishlist-button"
        aria-pressed={wishlisted}
        aria-label={wishlisted ? "Remove from wishlist" : "Save to wishlist"}
        disabled={pending}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill={wishlisted ? "currentColor" : "none"} aria-hidden="true">
          <path
            d="M12 20.5s-7.5-4.6-10-9.1C0.5 8.2 2 4.5 5.5 4c2.1-.3 4 .8 6.5 3.3C14.5 4.8 16.4 3.7 18.5 4c3.5.5 5 4.2 3.5 7.4-2.5 4.5-10 9.1-10 9.1Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
        </svg>
        {wishlisted ? "Saved" : "Save"}
      </button>
      {state.message && !state.ok && (
        <p className="alert alert--error" style={{ marginTop: "var(--space-2)" }}>{state.message}</p>
      )}
    </form>
  );
}
