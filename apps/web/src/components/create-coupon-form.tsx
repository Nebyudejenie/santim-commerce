"use client";

import { useActionState, useState } from "react";
import { createCouponAction, type CouponAdminActionState } from "@/server/actions/coupon-actions";

const INITIAL_STATE: CouponAdminActionState = { ok: false };

export function CreateCouponForm() {
  const [state, formAction, pending] = useActionState(createCouponAction, INITIAL_STATE);
  const [discountType, setDiscountType] = useState<"PERCENTAGE" | "FIXED_AMOUNT">("PERCENTAGE");

  return (
    <form action={formAction}>
      {state.message && (
        <p className={state.ok ? "alert alert--success" : "alert alert--error"}>{state.message}</p>
      )}

      <div className="form-row form-row--2">
        <div className="form-field">
          <label htmlFor="code">Code</label>
          <input id="code" name="code" type="text" required minLength={3} maxLength={40} placeholder="WELCOME10" />
        </div>
        <div className="form-field">
          <label htmlFor="description">Description (optional)</label>
          <input id="description" name="description" type="text" maxLength={200} />
        </div>
      </div>

      <div className="form-row form-row--2">
        <div className="form-field">
          <label htmlFor="discountType">Discount type</label>
          <select
            id="discountType"
            name="discountType"
            value={discountType}
            onChange={(e) => setDiscountType(e.target.value as "PERCENTAGE" | "FIXED_AMOUNT")}
          >
            <option value="PERCENTAGE">Percentage off</option>
            <option value="FIXED_AMOUNT">Fixed amount off</option>
          </select>
        </div>
        <div className="form-field">
          <label htmlFor="discountValue">
            {discountType === "PERCENTAGE" ? "Percent off (1-100)" : "Amount off (ETB)"}
          </label>
          <input
            id="discountValue"
            name="discountValue"
            type="number"
            step={discountType === "PERCENTAGE" ? "1" : "0.01"}
            min={discountType === "PERCENTAGE" ? "1" : "0.01"}
            max={discountType === "PERCENTAGE" ? "100" : undefined}
            required
          />
        </div>
      </div>

      <div className="form-row form-row--2">
        <div className="form-field">
          <label htmlFor="maxDiscountBirr">Max discount (ETB, optional)</label>
          <input id="maxDiscountBirr" name="maxDiscountBirr" type="number" step="0.01" min="0.01" />
          <p className="form-hint">Caps a percentage discount. Ignored for fixed-amount coupons.</p>
        </div>
        <div className="form-field">
          <label htmlFor="minSubtotalBirr">Minimum subtotal (ETB, optional)</label>
          <input id="minSubtotalBirr" name="minSubtotalBirr" type="number" step="0.01" min="0" />
        </div>
      </div>

      <div className="form-row form-row--2">
        <div className="form-field">
          <label htmlFor="redemptionsRemaining">Total redemption limit (optional)</label>
          <input id="redemptionsRemaining" name="redemptionsRemaining" type="number" step="1" min="1" />
          <p className="form-hint">Leave blank for unlimited. Each customer may redeem a coupon once regardless.</p>
        </div>
      </div>

      <div className="form-row form-row--2">
        <div className="form-field">
          <label htmlFor="validFrom">Valid from (optional)</label>
          <input id="validFrom" name="validFrom" type="date" />
        </div>
        <div className="form-field">
          <label htmlFor="validUntil">Valid until (optional)</label>
          <input id="validUntil" name="validUntil" type="date" />
        </div>
      </div>

      <button type="submit" className="btn btn--primary" disabled={pending}>
        {pending ? "Creating…" : "Create coupon"}
      </button>
    </form>
  );
}
