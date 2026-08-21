"use client";

import { useActionState } from "react";
import { toggleProductFeaturedAction } from "@/server/actions/admin-actions";
import type { AdminActionState } from "@/server/actions/admin-actions";

const INITIAL_STATE: AdminActionState = { ok: false };

export function ToggleFeaturedButton({ productId, featured }: { productId: string; featured: boolean }) {
  const [, formAction, pending] = useActionState(toggleProductFeaturedAction, INITIAL_STATE);

  return (
    <form action={formAction}>
      <input type="hidden" name="productId" value={productId} />
      <input type="hidden" name="featured" value={featured ? "false" : "true"} />
      <button type="submit" className="btn btn--secondary btn-sm" disabled={pending}>
        {pending ? "…" : featured ? "Unfeature" : "Feature"}
      </button>
    </form>
  );
}
