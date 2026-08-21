"use client";

import { useActionState } from "react";
import { importProductsCsvAction, type ImportCsvActionState } from "@/server/actions/listing-actions";

const INITIAL_STATE: ImportCsvActionState = { ok: false };

export function ImportProductsCsvForm() {
  const [state, formAction, pending] = useActionState(importProductsCsvAction, INITIAL_STATE);

  return (
    <div className="detail-card" style={{ marginBottom: "var(--space-6)" }}>
      <h3>Bulk import from CSV</h3>
      <p className="form-hint" style={{ marginBottom: "var(--space-3)" }}>
        Required columns: title, description, sku, priceBirr, onHand. Optional: subtitle, brand,
        imageUrls (one URL per line within the cell). Every row creates a new DRAFT listing — publish
        it separately once you&apos;re happy with it.
      </p>
      <form action={formAction} style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
        <input type="file" name="csvFile" accept=".csv,text/csv" required />
        <button type="submit" className="btn btn--secondary btn-sm" disabled={pending}>
          {pending ? "Importing…" : "Import"}
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
                <li key={r.row}>Row {r.row}: {r.message}</li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}
