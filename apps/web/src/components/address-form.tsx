"use client";

import { useActionState, useEffect } from "react";
import {
  createAddressAction,
  updateAddressAction,
  type AddressActionState,
} from "@/server/actions/address-actions";

const INITIAL_STATE: AddressActionState = { ok: false };

export interface AddressFormValues {
  readonly id?: string;
  readonly fullName?: string;
  readonly phone?: string;
  readonly city?: string;
  readonly subCity?: string | null;
  readonly woreda?: string | null;
  readonly streetLine?: string | null;
  readonly landmark?: string | null;
  readonly notes?: string | null;
}

export function AddressForm({
  address,
  onSaved,
}: {
  address?: AddressFormValues;
  onSaved?: () => void;
}) {
  const action = address?.id ? updateAddressAction : createAddressAction;
  const [state, formAction, pending] = useActionState(action, INITIAL_STATE);

  useEffect(() => {
    if (state.ok) onSaved?.();
    // Only re-run when the action's result identity changes, not on every
    // render — calling onSaved() unconditionally here would fire it again
    // on any unrelated re-render once state.ok is true.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={formAction}>
      {address?.id && <input type="hidden" name="addressId" value={address.id} />}
      {state.message && (
        <p className={state.ok ? "form-hint" : "alert alert--error"}>{state.message}</p>
      )}

      <div className="form-row form-row--2">
        <div className="form-field">
          <label htmlFor="fullName">Full name</label>
          <input id="fullName" name="fullName" type="text" required defaultValue={address?.fullName} />
        </div>
        <div className="form-field">
          <label htmlFor="phone">Phone</label>
          <input id="phone" name="phone" type="tel" required defaultValue={address?.phone} />
        </div>
      </div>

      <div className="form-row form-row--2">
        <div className="form-field">
          <label htmlFor="city">City</label>
          <input id="city" name="city" type="text" required defaultValue={address?.city} />
        </div>
        <div className="form-field">
          <label htmlFor="subCity">Sub-city (optional)</label>
          <input id="subCity" name="subCity" type="text" defaultValue={address?.subCity ?? ""} />
        </div>
      </div>

      <div className="form-row form-row--2">
        <div className="form-field">
          <label htmlFor="woreda">Woreda (optional)</label>
          <input id="woreda" name="woreda" type="text" defaultValue={address?.woreda ?? ""} />
        </div>
        <div className="form-field">
          <label htmlFor="streetLine">Street / area (optional)</label>
          <input id="streetLine" name="streetLine" type="text" defaultValue={address?.streetLine ?? ""} />
        </div>
      </div>

      <div className="form-field">
        <label htmlFor="landmark">Landmark (optional)</label>
        <input id="landmark" name="landmark" type="text" placeholder="e.g. near Bole Medhanealem" defaultValue={address?.landmark ?? ""} />
      </div>

      <button type="submit" className="btn btn--primary" disabled={pending}>
        {pending ? "Saving…" : address?.id ? "Save changes" : "Add address"}
      </button>
    </form>
  );
}
