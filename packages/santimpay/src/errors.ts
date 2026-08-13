/**
 * Error taxonomy — the anti-corruption layer for failures.
 *
 * SantimPay returns HTTP 200 with `{"status":"declined","message":"<free text>"}`
 * for business failures, and the free text includes raw PostgreSQL constraint
 * violations. If those strings reach your business logic, every future change
 * on their side is a production incident on yours.
 *
 * So we do what you should do with EVERY third-party API: translate at the
 * boundary into a small, stable, documented set of error types that your code
 * can switch on, and keep the raw upstream payload attached for support.
 */

/** Stable codes our application logic is allowed to branch on. */
export type DeclineCode =
  /** MSISDN not in +251XXXXXXXXX form. Fix the input; never retry. */
  | "INVALID_PHONE_NUMBER"
  /** Merchant escrow/deposit balance too low for a B2C payout. Business action. */
  | "INSUFFICIENT_MERCHANT_BALANCE"
  /** Unknown/stale partner id. Refresh the partner list. */
  | "PAYMENT_METHOD_NOT_SUPPORTED"
  /** Signing body malformed (wrong fields, injected `iat`). Bug on our side. */
  | "INVALID_TOKEN"
  /** Signature did not verify — wrong key, or testbed key against production. */
  | "SIGNATURE_VERIFICATION_FAILED"
  /** `id`/`clientReference` reused. NOT a failure — the original may have succeeded. */
  | "DUPLICATE_CLIENT_REFERENCE"
  /** Caller IP not allowlisted by SantimPay. Infra action. */
  | "IP_NOT_ALLOWED"
  /** Anything we have not seen before. Alert, inspect, then add a code. */
  | "UNKNOWN";

export interface SantimPayErrorContext {
  /** Our transaction id, so a log line is joinable to an order. */
  readonly transactionId?: string;
  /** The API operation that failed. */
  readonly operation?: string;
  /** Raw upstream body, retained verbatim for support tickets. */
  readonly raw?: unknown;
}

export abstract class SantimPayError extends Error {
  abstract readonly kind: string;
  /** Whether a naive retry of the identical request could plausibly succeed. */
  abstract readonly retryable: boolean;
  readonly context: SantimPayErrorContext;

  constructor(message: string, context: SantimPayErrorContext = {}) {
    super(message);
    this.name = new.target.name;
    this.context = context;
  }
}

/** Business rejection: HTTP 200 with status "declined". */
export class SantimPayDeclinedError extends SantimPayError {
  readonly kind = "declined" as const;
  readonly retryable = false;
  constructor(
    readonly code: DeclineCode,
    readonly upstreamMessage: string,
    context: SantimPayErrorContext = {},
  ) {
    super(`SantimPay declined (${code}): ${upstreamMessage}`, context);
  }
}

/**
 * The reference was already used. Deliberately its own type: this is the
 * expected outcome of a safe retry, and the correct response is to look the
 * original transaction up, not to surface a failure to the customer.
 */
export class DuplicateReferenceError extends SantimPayError {
  readonly kind = "duplicate_reference" as const;
  readonly retryable = false;
  constructor(readonly transactionId: string, context: SantimPayErrorContext = {}) {
    super(
      `Transaction id "${transactionId}" was already used. Resolve via fetchTransactionStatus() rather than re-initiating.`,
      context,
    );
  }
}

/** Transport failure: DNS, TCP, TLS, connection reset. Safe to retry. */
export class SantimPayNetworkError extends SantimPayError {
  readonly kind = "network" as const;
  readonly retryable = true;
  constructor(message: string, readonly cause_?: unknown, context: SantimPayErrorContext = {}) {
    super(message, context);
  }
}

/** Our deadline elapsed. Retryable, but the request MAY have been processed. */
export class SantimPayTimeoutError extends SantimPayError {
  readonly kind = "timeout" as const;
  readonly retryable = true;
  constructor(readonly timeoutMs: number, context: SantimPayErrorContext = {}) {
    super(
      `SantimPay request exceeded ${timeoutMs}ms. The request may still have been processed upstream — reconcile, do not assume failure.`,
      context,
    );
  }
}

/** Unexpected HTTP status (4xx/5xx). 5xx is retryable, 4xx is not. */
export class SantimPayHttpError extends SantimPayError {
  readonly kind = "http" as const;
  readonly retryable: boolean;
  constructor(
    readonly status: number,
    readonly body: string,
    context: SantimPayErrorContext = {},
  ) {
    super(`SantimPay returned HTTP ${status}: ${body.slice(0, 500)}`, context);
    this.retryable = status >= 500 || status === 429;
  }
}

/** A webhook or response signature failed verification. Never retry; alert. */
export class SantimPaySignatureError extends SantimPayError {
  readonly kind = "signature" as const;
  readonly retryable = false;
  constructor(message: string, context: SantimPayErrorContext = {}) {
    super(`Webhook signature rejected: ${message}`, context);
  }
}

/** Misconfiguration detected at construction or boot. Fail fast, loudly. */
export class SantimPayConfigError extends SantimPayError {
  readonly kind = "config" as const;
  readonly retryable = false;
}

/**
 * Map SantimPay's free-text decline messages onto our stable codes.
 * Matching is substring-based and case-insensitive because the upstream text
 * is not a contract and has changed before.
 */
export function classifyDecline(message: string): DeclineCode {
  const m = message.toLowerCase();

  if (m.includes("phone number must be in the format")) return "INVALID_PHONE_NUMBER";
  if (m.includes("chk_santimpay_wallets_balance_is_non_negative")) {
    return "INSUFFICIENT_MERCHANT_BALANCE";
  }
  if (m.includes("insufficient") && m.includes("balance")) {
    return "INSUFFICIENT_MERCHANT_BALANCE";
  }
  if (m.includes("payment method not supported")) return "PAYMENT_METHOD_NOT_SUPPORTED";
  if (m.includes("duplicate client reference")) return "DUPLICATE_CLIENT_REFERENCE";
  if (m.includes("crypto/ecdsa") || m.includes("verification error")) {
    return "SIGNATURE_VERIFICATION_FAILED";
  }
  if (m.includes("invalid token")) return "INVALID_TOKEN";
  if (m.includes("ip")) return "IP_NOT_ALLOWED";

  return "UNKNOWN";
}
