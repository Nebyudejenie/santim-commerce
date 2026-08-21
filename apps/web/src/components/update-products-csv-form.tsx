"use client";

import { useActionState } from "react";
import { updateProductsCsvAction, type UpdateCsvActionState } from "@/server/actions/listing-actions";

const INITIAL_STATE: UpdateCsvActionState = { ok: false };

export function UpdateProductsCsvForm() {
  const [state, formAction, pending] = useActionState(updateProductsCsvAction, INITIAL_STATE);

  return (
    <div className="detail-card" style={{ marginBottom: "var(--space-6)" }}>
      <h3>Bulk update from CSV</h3>
      <p className="form-hint" style={{ marginBottom: "var(--space-3)" }}>
        Matches each row to an existing listing by <code>sku</code> — the only required column.
        Every other column (title, subtitle, description, brand, priceBirr, onHand, status) is
        optional per row: leave a cell blank to leave that field unchanged. Export your catalogue
        first to get a file with the real SKUs already filled in.
      </p>
      <form action={formAction} style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
        <input type="file" name="csvFile" accept=".csv,text/csv" required />
        <button type="submit" className="btn btn--secondary btn-sm" disabled={pending}>
          {pending ? "Updating…" : "Update"}
        </button>
      </form>

      {state.message && (
        <p className={state.ok ? "form-hint" : "form-hint form-hint--error"} style={{ marginTop: "var(--space-3)" }}>
          {state.message}
        </p>
      )}

      {state.summary && state.summary.failedCount > 0 && (
        <div style={{ marginTop: "var(--space-3)" }}>
          <p style={{ fontWeight: 600, fontSize: "var(--text-sm)" }}>Rows that failed:</p>
          <ul style={{ fontSize: "var(--text-sm)", color: "var(--fg-muted)" }}>
            {state.summary.results
              .filter((r) => !r.ok)
              .map((r) => (
                <li key={r.row}>Row {r.row}{r.sku ? ` (${r.sku})` : ""}: {r.message}</li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
