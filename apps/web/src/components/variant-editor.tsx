"use client";

import { useActionState } from "react";
import { updateVariantAction, addVariantAction, type ListingActionState } from "@/server/actions/listing-actions";

const INITIAL_STATE: ListingActionState = { ok: false };

interface VariantRowProps {
  productId: string;
  variant: {
    id: string;
    title: string;
    sku: string;
    priceSantim: number;
    compareAtSantim: number | null;
    active: boolean;
    options: unknown;
    inventory: { onHand: number; lowStockThreshold: number; allowBackorder: boolean } | null;
  };
}

export function VariantRow({ productId, variant }: VariantRowProps) {
  const [state, formAction, pending] = useActionState(updateVariantAction, INITIAL_STATE);
  const options = (variant.options ?? {}) as Record<string, string>;
  const [existingOptionName, existingOptionValue] = Object.entries(options)[0] ?? ["", ""];

  return (
    <form
      action={formAction}
      style={{ display: "grid", gridTemplateColumns: "1fr 90px 90px 100px 100px 90px 90px 90px auto", gap: "var(--space-3)", alignItems: "center", padding: "var(--space-3) 0", borderBottom: "1px solid var(--border)" }}
    >
      <input type="hidden" name="variantId" value={variant.id} />
      <input type="hidden" name="productId" value={productId} />
      <div>
        <div style={{ fontWeight: 600 }}>{variant.title}</div>
        <div style={{ fontSize: "var(--text-xs)", color: "var(--fg-muted)" }}>{variant.sku}</div>
      </div>
      <input
        name="optionName"
        type="text"
        defaultValue={existingOptionName}
        placeholder="Size"
        aria-label="Option name"
        maxLength={40}
      />
      <input
        name="optionValue"
        type="text"
        defaultValue={existingOptionValue}
        placeholder="M"
        aria-label="Option value"
        maxLength={40}
      />
      <input
        name="priceBirr"
        type="number"
        step="0.01"
        min="0.01"
        defaultValue={(variant.priceSantim / 100).toFixed(2)}
        aria-label="Price in ETB"
      />
      <input
        name="compareAtBirr"
        type="number"
        step="0.01"
        min="0.01"
        defaultValue={variant.compareAtSantim ? (variant.compareAtSantim / 100).toFixed(2) : ""}
        aria-label="Compare-at price in ETB"
        placeholder="Was price"
        title="Shown struck through next to the real price. Leave blank for no sale pricing."
      />
      <input
        name="onHand"
        type="number"
        step="1"
        min="0"
        defaultValue={variant.inventory?.onHand ?? 0}
        aria-label="Stock quantity"
      />
      <input
        name="lowStockThreshold"
        type="number"
        step="1"
        min="0"
        defaultValue={variant.inventory?.lowStockThreshold ?? 5}
        aria-label="Low stock alert threshold"
        title="Get notified when stock falls to or below this number"
      />
      <label style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "var(--text-sm)" }}>
        <input type="checkbox" name="active" defaultChecked={variant.active} />
        Active
      </label>
      <label
        style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "var(--text-sm)" }}
        title="Stays buyable (made-to-order) even after stock hits zero"
      >
        <input type="checkbox" name="allowBackorder" defaultChecked={variant.inventory?.allowBackorder ?? false} />
        Backorder
      </label>
      <div>
        <button type="submit" className="btn btn--secondary btn-sm" disabled={pending}>
          {pending ? "…" : "Save"}
        </button>
        {state.message && (
          <span
            style={{ marginLeft: "var(--space-2)", fontSize: "var(--text-xs)", color: state.ok ? "var(--success)" : "var(--danger)" }}
          >
            {state.message}
          </span>
        )}
      </div>
    </form>
  );
}

export function AddVariantForm({ productId }: { productId: string }) {
  const [state, formAction, pending] = useActionState(addVariantAction, INITIAL_STATE);

  return (
    <form
      action={formAction}
      style={{ display: "grid", gridTemplateColumns: "1fr 1fr 100px 100px 100px 90px auto", gap: "var(--space-3)", alignItems: "end", marginTop: "var(--space-4)" }}
    >
      <input type="hidden" name="productId" value={productId} />
      <div className="form-field" style={{ margin: 0 }}>
        <label htmlFor="new-variant-title">Variant name</label>
        <input id="new-variant-title" name="title" type="text" placeholder="e.g. Black / L" />
      </div>
      <div className="form-field" style={{ margin: 0, display: "flex", gap: "var(--space-2)" }}>
        <div>
          <label htmlFor="new-variant-option-name">Option name</label>
          <input id="new-variant-option-name" name="optionName" type="text" placeholder="Size" />
        </div>
        <div>
          <label htmlFor="new-variant-option-value">Value</label>
          <input id="new-variant-option-value" name="optionValue" type="text" placeholder="L" />
        </div>
      </div>
      <div className="form-field" style={{ margin: 0 }}>
        <label htmlFor="new-variant-sku">SKU</label>
        <input id="new-variant-sku" name="sku" type="text" required />
      </div>
      <div className="form-field" style={{ margin: 0 }}>
        <label htmlFor="new-variant-price">Price (ETB)</label>
        <input id="new-variant-price" name="priceBirr" type="number" step="0.01" min="0.01" required />
      </div>
      <div className="form-field" style={{ margin: 0 }}>
        <label htmlFor="new-variant-stock">Stock</label>
        <input id="new-variant-stock" name="onHand" type="number" step="1" min="0" required defaultValue={0} />
      </div>
      <label
        style={{ display: "flex", alignItems: "center", gap: "4px", fontSize: "var(--text-sm)" }}
        title="Stays buyable (made-to-order) even after stock hits zero"
      >
        <input type="checkbox" name="allowBackorder" />
        Backorder
      </label>
      <button type="submit" className="btn btn--primary btn-sm" disabled={pending}>
        {pending ? "Adding…" : "Add variant"}
      </button>
      {state.message && !state.ok && (
        <p style={{ gridColumn: "1 / -1", color: "var(--danger)", fontSize: "var(--text-xs)" }}>{state.message}</p>
      )}
    </form>
  );
}
