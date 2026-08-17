/**
 * Mock carrier client — curriculum Phase 12 §2 / Lab 12.2.
 *
 * Simulates a real shipping carrier's REST API shape closely enough to
 * prove the pattern Lab 12.2 asks for, without needing a real carrier
 * account, an API key, or network access: two operations, two genuinely
 * different safety properties.
 *
 * WHY TWO OPERATIONS, TWO DIFFERENT SAFETY PROPERTIES
 * A rate quote is a pure calculation — asking twice costs nothing extra and
 * returns the same answer, no different from calling Math.sqrt() twice.
 * Label generation is a real, billable side effect on the carrier's own
 * books — calling it twice for the same shipment is a real money mistake.
 * Real carrier APIs (Shippo, EasyPost, and this one) solve that the same
 * way SantimPay solves duplicate payment attempts: the caller supplies an
 * idempotency key, and a repeated key returns the SAME label instead of
 * minting a second one — see `carrierLedger` below, which simulates
 * exactly that carrier-side behavior, not just this app's own.
 */

import crypto from "node:crypto";

export interface RateQuoteInput {
  readonly weightGrams: number;
  readonly destinationZone: "ADDIS_ABABA" | "REGIONAL";
}

export interface RateQuote {
  readonly carrierRateCents: number;
  readonly etaDays: number;
}

/** Pure calculation. Safe to call any number of times — never mutates anything. */
export async function getRateQuote(input: RateQuoteInput): Promise<RateQuote> {
  await simulateNetworkDelay();
  const base = input.destinationZone === "ADDIS_ABABA" ? 15_000 : 35_000;
  const weightSurchargeCents = Math.floor(input.weightGrams / 1000) * 500;
  return {
    carrierRateCents: base + weightSurchargeCents,
    etaDays: input.destinationZone === "ADDIS_ABABA" ? 1 : 3,
  };
}

export interface GenerateLabelInput {
  /** Client-supplied idempotency key — the carrier's own dedup key, not ours. */
  readonly idempotencyKey: string;
  readonly orderId: string;
}

export interface LabelResult {
  readonly carrierLabelId: string;
  readonly trackingNumber: string;
  readonly labelUrl: string;
}

/**
 * The carrier's own idempotency ledger. A real carrier keeps one server-side;
 * this simulates it so that TWO calls with the SAME key — whether from a
 * genuine retry or from two of our own concurrent requests racing after
 * losing the database-level race in label-service.ts — return the identical
 * label instead of each minting a new, separately-billable one.
 */
const carrierLedger = new Map<string, LabelResult>();

export async function generateLabel(input: GenerateLabelInput): Promise<LabelResult> {
  await simulateNetworkDelay();

  const existing = carrierLedger.get(input.idempotencyKey);
  if (existing) return existing;

  const result: LabelResult = {
    carrierLabelId: `MOCK-${crypto.randomUUID()}`,
    trackingNumber: `TRK${crypto.randomInt(1_000_000_000, 9_999_999_999)}`,
    labelUrl: `https://mock-carrier.example/labels/${input.idempotencyKey}.pdf`,
  };
  carrierLedger.set(input.idempotencyKey, result);
  return result;
}

/** Exposed for tests that need to reset the simulated carrier's own state. */
export function _resetCarrierLedgerForTests(): void {
  carrierLedger.clear();
}

function simulateNetworkDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 15));
}
