"use client";

import { useState } from "react";
import { AddressForm, type AddressFormValues } from "./address-form";
import { DeleteAddressButton } from "./delete-address-button";

function formatAddressLine(address: AddressFormValues): string {
  return [address.streetLine, address.woreda, address.subCity, address.city].filter(Boolean).join(", ");
}

export function AddressList({ addresses }: { addresses: AddressFormValues[] }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingNew, setAddingNew] = useState(false);

  return (
    <div>
      {addresses.length === 0 && !addingNew && (
        <p className="empty-note">No saved addresses yet.</p>
      )}

      {addresses.map((address) =>
        editingId === address.id ? (
          <div key={address.id} className="detail-card">
            <AddressForm address={address} onSaved={() => setEditingId(null)} />
            <button type="button" className="btn btn--secondary btn-sm" style={{ marginTop: "var(--space-3)" }} onClick={() => setEditingId(null)}>
              Cancel
            </button>
          </div>
        ) : (
          <div key={address.id} className="detail-card">
            <p style={{ fontWeight: 600 }}>{address.fullName}</p>
            <p style={{ color: "var(--fg-muted)", fontSize: "var(--text-sm)" }}>{address.phone}</p>
            <p style={{ color: "var(--fg-muted)", fontSize: "var(--text-sm)" }}>{formatAddressLine(address)}</p>
            {address.landmark && (
              <p style={{ color: "var(--fg-faint)", fontSize: "var(--text-xs)" }}>Near {address.landmark}</p>
            )}
            <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
              <button type="button" className="btn btn--secondary btn-sm" onClick={() => setEditingId(address.id ?? null)}>
                Edit
              </button>
              <DeleteAddressButton addressId={address.id!} />
            </div>
          </div>
        ),
      )}

      {addingNew ? (
        <div className="detail-card">
          <h3>New address</h3>
          <AddressForm onSaved={() => setAddingNew(false)} />
          <button type="button" className="btn btn--secondary btn-sm" style={{ marginTop: "var(--space-3)" }} onClick={() => setAddingNew(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn--primary" onClick={() => setAddingNew(true)}>
          Add a new address
        </button>
      )}
    </div>
  );
}
