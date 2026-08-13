/**
 * Wire types (what SantimPay actually sends) and domain types (what our
 * application is allowed to see). The mapping between them lives in
 * `normalizeTransaction` — the anti-corruption layer.
 */

/** Raw status strings observed on the wire. Do not use these in business logic. */
export type WireStatus = "PENDING" | "COMPLETED" | "FAILED" | "SUCCESS" | "declined" | string;

/**
 * Our normalised status. Note that SantimPay reports terminal success as
 * `COMPLETED` for payments but `SUCCESS` for the immediate B2C response; both
 * collapse to `COMPLETED` here so no caller has to remember the difference.
 */
export type PaymentStatus = "PENDING" | "COMPLETED" | "FAILED" | "DECLINED";

/** Terminal states never transition again. Used by the order state machine. */
export const TERMINAL_STATUSES: readonly PaymentStatus[] = ["COMPLETED", "FAILED", "DECLINED"];

export function isTerminal(status: PaymentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function normalizeStatus(wire: WireStatus): PaymentStatus {
  switch (String(wire).toUpperCase()) {
    case "COMPLETED":
    case "SUCCESS":
      return "COMPLETED";
    case "PENDING":
      return "PENDING";
    case "FAILED":
      return "FAILED";
    case "DECLINED":
      return "DECLINED";
    default:
      // Unknown status: treat as pending, never as success. Fail safe means
      // "do not ship goods", not "assume the worst and refund".
      return "PENDING";
  }
}

/** Transaction as it appears on the wire. Every field optional — gateways drift. */
export interface WireTransaction {
  txnId?: string;
  created_at?: string;
  updated_at?: string;
  thirdPartyId?: string;
  transactionType?: string;
  merId?: string;
  merName?: string;
  address?: string;
  amount?: string | number;
  commission?: string | number;
  totalAmount?: string | number;
  currency?: string;
  reason?: string;
  msisdn?: string;
  accountNumber?: string;
  clientReference?: string;
  paymentVia?: string;
  payment_via?: string;
  refId?: string;
  ref_id?: string;
  commissionAmountInPercent?: number;
  providerCommissionAmountinPercent?: number;
  commissionFromCustomer?: number;
  message?: string;
  status?: WireStatus;
  StatusReason?: string;
  statusReason?: string;
  receiverWalletID?: string;
  RecieverWalletID?: string;
  successRedirectUrl?: string;
  failureRedirectUrl?: string;
  [key: string]: unknown;
}

/** The shape the rest of our system is allowed to depend on. */
export interface Transaction {
  /** SantimPay's transaction id. */
  readonly gatewayTransactionId: string;
  /** OUR id — the join key back to `payment_intent`. */
  readonly merchantTransactionId: string;
  /** `payment` or `payout` (B2C). */
  readonly type: "payment" | "payout";
  readonly status: PaymentStatus;
  /** Amount before commission, in santim. */
  readonly amountSantim: number;
  /** Commission deducted, in santim. */
  readonly commissionSantim: number;
  /** Total including commission, in santim. */
  readonly totalSantim: number;
  readonly currency: string;
  readonly reason: string;
  /** Channel used: Telebirr, CBE Birr, Bunna bank, … */
  readonly channel: string | null;
  /** The bank's/channel's own reference — what the customer's SMS shows. */
  readonly channelReference: string | null;
  readonly msisdn: string | null;
  readonly accountNumber: string | null;
  readonly clientReference: string | null;
  readonly message: string | null;
  readonly statusReason: string | null;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
  /** The untouched upstream body, for support tickets and audit. */
  readonly raw: WireTransaction;
}

function toSantim(value: string | number | undefined): number {
  if (value === undefined || value === null || value === "") return 0;
  const asString = typeof value === "number" ? value.toFixed(2) : String(value).trim();
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(asString);
  if (!match) return 0;
  const [, sign, whole = "0", frac = ""] = match;
  const cents = Number(whole) * 100 + Number(frac.slice(0, 2).padEnd(2, "0"));
  return sign === "-" ? -cents : cents;
}

function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  // SantimPay mixes RFC3339 ("2023-02-28T10:26:17.904879Z") with Go's default
  // format ("2023-04-07 08:08:48.127080706 +0000 UTC"). Handle both.
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct;
  const goStyle = value.replace(" +0000 UTC", "Z").replace(" ", "T");
  const parsed = new Date(goStyle);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Translate a wire transaction into our domain type. */
export function normalizeTransaction(wire: WireTransaction): Transaction {
  const amountSantim = toSantim(wire.amount);
  const commissionSantim = toSantim(wire.commission);
  const totalSantim = wire.totalAmount !== undefined
    ? toSantim(wire.totalAmount)
    : amountSantim + commissionSantim;

  return {
    gatewayTransactionId: wire.txnId ?? "",
    merchantTransactionId: wire.thirdPartyId ?? "",
    type: wire.transactionType === "GATEWAY_PAYOUT" ? "payout" : "payment",
    status: normalizeStatus(wire.status ?? "PENDING"),
    amountSantim,
    commissionSantim,
    totalSantim,
    currency: wire.currency ?? "ETB",
    reason: wire.reason ?? "",
    channel: wire.paymentVia ?? wire.payment_via ?? null,
    channelReference: wire.refId ?? wire.ref_id ?? null,
    msisdn: wire.msisdn || null,
    accountNumber: wire.accountNumber || null,
    clientReference: wire.clientReference ?? null,
    message: wire.message ?? null,
    statusReason: wire.StatusReason ?? wire.statusReason ?? null,
    createdAt: toDate(wire.created_at),
    updatedAt: toDate(wire.updated_at),
    raw: wire,
  };
}

/** A B2C payout partner from `GET /payout/partners`. */
export interface PayoutPartner {
  readonly id: string;
  readonly name: string;
  readonly raw: Record<string, unknown>;
}
