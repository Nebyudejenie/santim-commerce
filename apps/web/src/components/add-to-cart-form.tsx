"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { addToCartAction, type CartActionState } from "@/server/actions/cart-actions";
import { requestBackInStockAction, type BackInStockActionState } from "@/server/actions/back-in-stock-actions";
import { Money } from "./money";

export interface VariantOption {
  id: string;
  title: string;
  priceSantim: number;
  /** Struck-through "was" price, shown next to priceSantim when set and
   * genuinely higher — Variant.compareAtSantim, seller-configurable. */
  compareAtSantim: number | null;
  options: Record<string, string>;
  available: number;
  /** Below this, the stock note reads "Only N left" instead of "In stock" —
   * Inventory.lowStockThreshold, seller-configurable, not a fixed number. */
  lowStockThreshold: number;
}

const INITIAL_STATE: CartActionState = { ok: false };
const INITIAL_BACK_IN_STOCK_STATE: BackInStockActionState = { ok: false };

/**
 * Client component: variant selection needs instant feedback (stock note,
 * price update, disabled sizes) that a full server round-trip would make feel
 * sluggish. The actual mutation still goes through the Server Action —
 * this component only owns which variant is currently selected.
 */
export function AddToCartForm({
  variants,
  signedIn = false,
  requestedVariantIds = [],
}: {
  variants: VariantOption[];
  /** Whether the current viewer is signed in — the back-in-stock button
   * needs an account, same convention as wishlist/notifications. */
  signedIn?: boolean;
  /** Variant ids this viewer has already requested a real, still-pending
   * back-in-stock notification for. */
  requestedVariantIds?: readonly string[];
}) {
  const optionKey = useMemo(() => Object.keys(variants[0]?.options ?? {})[0] ?? "Option", [variants]);
  const [selectedId, setSelectedId] = useState<string | undefined>(
    variants.find((v) => v.available > 0)?.id ?? variants[0]?.id,
  );
  const [state, formAction, pending] = useActionState(addToCartAction, INITIAL_STATE);
  const [backInStockState, backInStockFormAction, backInStockPending] = useActionState(
    requestBackInStockAction,
    INITIAL_BACK_IN_STOCK_STATE,
  );

  const selected = variants.find((v) => v.id === selectedId);
  const alreadyRequested = selected ? requestedVariantIds.includes(selected.id) : false;

  return (
    <>
    <form action={formAction}>
      <input type="hidden" name="variantId" value={selectedId ?? ""} />
      <input type="hidden" name="quantity" value="1" />

      <p className="pdp__price">
        {selected ? <Money santim={selected.priceSantim} /> : "—"}
        {selected && selected.compareAtSantim !== null && selected.compareAtSantim > selected.priceSantim && (
          <Money santim={selected.compareAtSantim} className="pdp__compare-at" />
        )}
      </p>

      <div role="group" aria-labelledby="option-label">
        <p className="option-label" id="option-label">
          <span>{optionKey}</span>
          {selected && <span>{selected.options[optionKey]}</span>}
        </p>
        <div className="option-grid">
          {variants.map((v) => (
            <button
              key={v.id}
              type="button"
              className="option-swatch"
              data-selected={v.id === selectedId}
              disabled={v.available === 0}
              onClick={() => setSelectedId(v.id)}
              aria-pressed={v.id === selectedId}
            >
              {v.options[optionKey]}
            </button>
          ))}
        </div>
      </div>

      <p
        className={
          "stock-note " +
          (selected
            ? selected.available === 0
              ? "stock-note--out"
              : selected.available === Infinity
                ? "stock-note--ok"
                : selected.available <= selected.lowStockThreshold
                  ? "stock-note--low"
                  : "stock-note--ok"
            : "")
        }
        role="status"
      >
        {selected
          ? selected.available === 0
            ? "Out of stock in this size"
            : selected.available === Infinity
              ? "Available to order — ships once restocked"
              : selected.available <= selected.lowStockThreshold
                ? `Only ${selected.available} left`
                : "In stock"
          : ""}
      </p>

      {state.error && <p className="alert alert--error">{state.error}</p>}
      {state.ok && <p className="alert alert--success">Added to your bag.</p>}

      <button
        type="submit"
        className="btn btn--primary btn--full btn--lg"
        disabled={!selected || selected.available === 0 || pending}
      >
        {pending ? "Adding…" : selected?.available === 0 ? "Out of stock" : "Add to bag"}
      </button>
    </form>

    {selected && selected.available === 0 && (
      <div style={{ marginTop: "var(--space-3)" }}>
        {!signedIn ? (
          <p className="form-hint">
            <Link href="/login">Sign in</Link> to get notified when this is back in stock.
          </p>
        ) : alreadyRequested || backInStockState.ok ? (
          <p className="form-hint">{backInStockState.message ?? "We'll notify you when this is back in stock."}</p>
        ) : (
          <form action={backInStockFormAction}>
            <input type="hidden" name="variantId" value={selected.id} />
            {backInStockState.message && !backInStockState.ok && (
              <p className="form-hint form-hint--error">{backInStockState.message}</p>
            )}
            <button type="submit" className="btn btn--secondary btn-sm" disabled={backInStockPending}>
              {backInStockPending ? "…" : "Notify me when back in stock"}
            </button>
          </form>
        )}
      </div>
    )}
    </>
  );
}
