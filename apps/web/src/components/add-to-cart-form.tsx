"use client";

import { useActionState, useMemo, useState } from "react";
import { addToCartAction, type CartActionState } from "@/server/actions/cart-actions";
import { Money } from "./money";

export interface VariantOption {
  id: string;
  title: string;
  priceSantim: number;
  options: Record<string, string>;
  available: number;
}

const INITIAL_STATE: CartActionState = { ok: false };

/**
 * Client component: variant selection needs instant feedback (stock note,
 * price update, disabled sizes) that a full server round-trip would make feel
 * sluggish. The actual mutation still goes through the Server Action —
 * this component only owns which variant is currently selected.
 */
export function AddToCartForm({ variants }: { variants: VariantOption[] }) {
  const optionKey = useMemo(() => Object.keys(variants[0]?.options ?? {})[0] ?? "Option", [variants]);
  const [selectedId, setSelectedId] = useState<string | undefined>(
    variants.find((v) => v.available > 0)?.id ?? variants[0]?.id,
  );
  const [state, formAction, pending] = useActionState(addToCartAction, INITIAL_STATE);

  const selected = variants.find((v) => v.id === selectedId);

  return (
    <form action={formAction}>
      <input type="hidden" name="variantId" value={selectedId ?? ""} />
      <input type="hidden" name="quantity" value="1" />

      <p className="pdp__price">
        {selected ? <Money santim={selected.priceSantim} /> : "—"}
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
              : selected.available <= 5
                ? "stock-note--low"
                : "stock-note--ok"
            : "")
        }
        role="status"
      >
        {selected
          ? selected.available === 0
            ? "Out of stock in this size"
            : selected.available <= 5
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
  );
}
