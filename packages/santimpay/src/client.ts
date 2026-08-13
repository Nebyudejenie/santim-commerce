/**
 * SantimPayClient — the only place in the codebase that knows SantimPay exists.
 *
 * Everything above this line is our domain; everything below is a vendor's
 * quirks. That boundary is the whole point of an integration layer: when
 * SantimPay changes a field name, exactly one file changes.
 */

import { signES256 } from "./crypto.js";
import {
  DuplicateReferenceError,
  SantimPayConfigError,
  SantimPayDeclinedError,
  classifyDecline,
  type SantimPayErrorContext,
} from "./errors.js";
import { DEFAULT_RETRY, getJson, postJson, type HttpOptions, type RetryPolicy } from "./http.js";
import { toGatewayAmount, type Santim } from "./money.js";
import { normalizeEthiopianMsisdn } from "./phone.js";
import {
  normalizeTransaction,
  type PayoutPartner,
  type Transaction,
  type WireTransaction,
} from "./types.js";

export const PRODUCTION_BASE_URL = "https://services.santimpay.com/api/v1/gateway";
export const TESTBED_BASE_URL = "https://testnet.santimpay.com/api/v1/gateway";

export type SantimPayEnvironment = "production" | "testbed";

export interface SantimPayConfig {
  readonly merchantId: string;
  /** EC P-256 private key, PEM. Load from a secret manager, never from git. */
  readonly privateKey: string;
  readonly environment: SantimPayEnvironment;
  /** Bearer token issued by SantimPay. Required in production (PDF p.5). */
  readonly gatewayToken?: string;
  /** Per-request deadline. Default 15s: the gateway fronts slow bank rails. */
  readonly timeoutMs?: number;
  readonly retry?: RetryPolicy;
  /** Override for tests / local mock gateway. */
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRetry?: HttpOptions["onRetry"];
}

export interface CheckoutSessionInput {
  /**
   * OUR transaction id. Must be globally unique and generated ONCE, persisted
   * BEFORE this call. This is the idempotency key for the entire payment:
   * SantimPay has no `Idempotency-Key` header, so reuse is detected by this
   * value alone.
   */
  readonly transactionId: string;
  readonly amount: Santim;
  /** Shown to the payer on the hosted page. Keep it recognisable on a bank statement. */
  readonly reason: string;
  readonly successRedirectUrl: string;
  readonly failureRedirectUrl: string;
  readonly cancelRedirectUrl?: string;
  /** Our server-to-server webhook endpoint. Must be public HTTPS. */
  readonly notifyUrl: string;
  /** Optional; pre-fills the payer's number on the hosted page. Any local format. */
  readonly phoneNumber?: string;
}

export interface DirectPaymentInput extends Omit<CheckoutSessionInput, "successRedirectUrl" | "failureRedirectUrl" | "cancelRedirectUrl"> {
  /** Partner id from `listPayoutPartners()`, e.g. "Telebirr". */
  readonly paymentMethod: string;
  /** Required for direct payment — this is who gets the prompt. */
  readonly phoneNumber: string;
}

export interface PayoutInput {
  readonly transactionId: string;
  /** Additional merchant reference; may equal `transactionId`. */
  readonly clientReference?: string;
  readonly amount: Santim;
  readonly reason: string;
  /** Receiver phone (any local format) or bank account number. */
  readonly receiverAccountNumber: string;
  /** Partner id from `listPayoutPartners()`. */
  readonly paymentMethod: string;
  readonly notifyUrl: string;
}

export class SantimPayClient {
  readonly #merchantId: string;
  readonly #privateKey: string;
  readonly #baseUrl: string;
  readonly #http: HttpOptions;
  readonly environment: SantimPayEnvironment;

  constructor(config: SantimPayConfig) {
    assertNonEmpty(config.merchantId, "merchantId");
    assertNonEmpty(config.privateKey, "privateKey");

    if (!config.privateKey.includes("-----BEGIN")) {
      throw new SantimPayConfigError(
        "privateKey does not look like PEM. If it is stored base64-encoded in your secret manager, decode it before constructing the client.",
      );
    }

    // Fail fast on the misconfiguration that costs real money: pointing at
    // production with an incomplete production setup. A boot-time crash is
    // cheap; discovering it at the first customer checkout is not.
    if (config.environment === "production" && !config.gatewayToken) {
      throw new SantimPayConfigError(
        "gatewayToken is required in production. The integration document (p.5) specifies it as a bearer token on every request; the vendor SDK omits it.",
      );
    }

    this.environment = config.environment;
    this.#merchantId = config.merchantId;
    this.#privateKey = config.privateKey;
    this.#baseUrl = (
      config.baseUrl ??
      (config.environment === "production" ? PRODUCTION_BASE_URL : TESTBED_BASE_URL)
    ).replace(/\/+$/, "");

    this.#http = {
      timeoutMs: config.timeoutMs ?? 15_000,
      retry: config.retry ?? DEFAULT_RETRY,
      gatewayToken: config.gatewayToken,
      userAgent: "santim-commerce/1.0 (+hardened-client)",
      fetchImpl: config.fetchImpl,
      sleep: config.sleep,
      onRetry: config.onRetry,
    };
  }

  /** Unix seconds — the `generated` claim in every signing body. */
  #now(): number {
    return Math.floor(Date.now() / 1000);
  }

  /**
   * Create a hosted checkout session and return the URL to redirect to.
   *
   * Call this AFTER persisting the payment intent. If the process dies between
   * this call returning and your commit, the reconciler recovers the payment
   * from `transactionId`; if you had not persisted the id first, it could not.
   */
  async createCheckoutSession(input: CheckoutSessionInput): Promise<{ paymentUrl: string }> {
    const context: SantimPayErrorContext = {
      transactionId: input.transactionId,
      operation: "initiate-payment",
    };
    assertNonEmpty(input.transactionId, "transactionId");
    assertHttps(input.notifyUrl, "notifyUrl");

    const amount = toGatewayAmount(input.amount);

    const signedToken = signES256(
      {
        amount,
        paymentReason: input.reason,
        merchantId: this.#merchantId,
        generated: this.#now(),
      },
      this.#privateKey,
    );

    const payload: Record<string, unknown> = {
      id: input.transactionId,
      amount,
      reason: input.reason,
      merchantId: this.#merchantId,
      signedToken,
      successRedirectUrl: input.successRedirectUrl,
      failureRedirectUrl: input.failureRedirectUrl,
      cancelRedirectUrl: input.cancelRedirectUrl ?? input.failureRedirectUrl,
      notifyUrl: input.notifyUrl,
    };

    if (input.phoneNumber) {
      payload["phoneNumber"] = normalizeEthiopianMsisdn(input.phoneNumber);
    }

    const response = await postJson<{ url?: string } & WireTransaction>(
      `${this.#baseUrl}/initiate-payment`,
      payload,
      this.#http,
      context,
    );

    this.#assertNotDeclined(response, context);

    if (!response.url) {
      throw new SantimPayDeclinedError(
        "UNKNOWN",
        `initiate-payment returned no url: ${JSON.stringify(response).slice(0, 300)}`,
        { ...context, raw: response },
      );
    }

    return { paymentUrl: response.url };
  }

  /**
   * Charge a specific wallet directly — SantimPay pushes a prompt to the
   * customer's handset instead of rendering a hosted page. Better conversion,
   * but you own the channel picker and its error states.
   */
  async directPayment(input: DirectPaymentInput): Promise<Transaction> {
    const context: SantimPayErrorContext = {
      transactionId: input.transactionId,
      operation: "direct-payment",
    };
    assertNonEmpty(input.transactionId, "transactionId");
    assertHttps(input.notifyUrl, "notifyUrl");

    const amount = toGatewayAmount(input.amount);
    const phoneNumber = normalizeEthiopianMsisdn(input.phoneNumber);

    const signedToken = signES256(
      {
        amount,
        paymentReason: input.reason,
        paymentMethod: input.paymentMethod,
        phoneNumber,
        merchantId: this.#merchantId,
        generated: this.#now(),
      },
      this.#privateKey,
    );

    const response = await postJson<WireTransaction>(
      `${this.#baseUrl}/direct-payment`,
      {
        id: input.transactionId,
        amount,
        reason: input.reason,
        merchantId: this.#merchantId,
        signedToken,
        phoneNumber,
        paymentMethod: input.paymentMethod,
        notifyUrl: input.notifyUrl,
      },
      this.#http,
      context,
    );

    this.#assertNotDeclined(response, context);
    return normalizeTransaction(response);
  }

  /**
   * THE source of truth. The webhook tells you to look; this tells you what is
   * true. Never fulfil an order on the strength of a callback alone.
   */
  async fetchTransactionStatus(transactionId: string): Promise<Transaction> {
    const context: SantimPayErrorContext = {
      transactionId,
      operation: "fetch-transaction-status",
    };
    assertNonEmpty(transactionId, "transactionId");

    const generated = this.#now();

    // NOTE: this signing body uses `merId`, while every other operation uses
    // `merchantId`. Documented in the Additional integration document; getting
    // it wrong yields "crypto/ecdsa: verification error".
    const signedToken = signES256(
      { id: transactionId, merId: this.#merchantId, generated },
      this.#privateKey,
    );

    const response = await postJson<WireTransaction>(
      `${this.#baseUrl}/fetch-transaction-status`,
      {
        id: transactionId,
        merchantId: this.#merchantId,
        signedToken,
        fullParam: true,
        generated,
      },
      this.#http,
      context,
    );

    this.#assertNotDeclined(response, context);
    return normalizeTransaction(response);
  }

  /** B2C payout partners. Cache the result; refresh daily. */
  async listPayoutPartners(): Promise<PayoutPartner[]> {
    const response = await getJson<unknown>(
      `${this.#baseUrl}/payout/partners`,
      this.#http,
      { operation: "payout/partners" },
    );

    const rows: Record<string, unknown>[] = Array.isArray(response)
      ? (response as Record<string, unknown>[])
      : Array.isArray((response as Record<string, unknown>)?.["data"])
        ? ((response as Record<string, unknown>)["data"] as Record<string, unknown>[])
        : [];

    return rows.map((row) => ({
      id: String(row["id"] ?? row["ID"] ?? row["name"] ?? ""),
      name: String(row["name"] ?? row["Name"] ?? row["id"] ?? ""),
      raw: row,
    }));
  }

  /**
   * B2C: send money to a customer (refund, payout, withdrawal). Debited from
   * the merchant escrow balance in real time.
   *
   * FIXES A VENDOR BUG: the published SDK calls its token helper with an extra
   * `this.merchantId` argument, shifting `paymentMethod` and `phoneNumber` by
   * one position, so every payout it signs carries a wrong payload. See
   * docs/01-santimpay-protocol-spec.md §2.1.
   */
  async payout(input: PayoutInput): Promise<Transaction> {
    const context: SantimPayErrorContext = {
      transactionId: input.transactionId,
      operation: "payout-transfer",
    };
    assertNonEmpty(input.transactionId, "transactionId");
    assertHttps(input.notifyUrl, "notifyUrl");

    const amount = toGatewayAmount(input.amount);
    // Phone numbers get normalised; bank account numbers pass through.
    const receiver = /^[+0-9\s-]+$/.test(input.receiverAccountNumber) && input.receiverAccountNumber.replace(/\D/g, "").length >= 9
      ? tryNormalize(input.receiverAccountNumber)
      : input.receiverAccountNumber;

    const signedToken = signES256(
      {
        amount,
        paymentReason: input.reason,
        paymentMethod: input.paymentMethod,
        phoneNumber: receiver,
        merchantId: this.#merchantId,
        generated: this.#now(),
      },
      this.#privateKey,
    );

    const response = await postJson<WireTransaction>(
      `${this.#baseUrl}/payout-transfer`,
      {
        id: input.transactionId,
        clientReference: input.clientReference ?? input.transactionId,
        amount,
        reason: input.reason,
        merchantId: this.#merchantId,
        signedToken,
        receiverAccountNumber: receiver,
        paymentMethod: input.paymentMethod,
        notifyUrl: input.notifyUrl,
      },
      this.#http,
      context,
    );

    this.#assertNotDeclined(response, context);
    return normalizeTransaction(response);
  }

  /**
   * SantimPay signals business failures with HTTP 200 + `status: "declined"`.
   * Checking only `response.ok` — as most integrations do — silently treats
   * every decline as a success.
   */
  #assertNotDeclined(response: WireTransaction, context: SantimPayErrorContext): void {
    const status = String(response.status ?? "").toLowerCase();
    if (status !== "declined") return;

    const message = String(response.message ?? "declined without a message");
    const code = classifyDecline(message);

    if (code === "DUPLICATE_CLIENT_REFERENCE") {
      throw new DuplicateReferenceError(context.transactionId ?? "<unknown>", {
        ...context,
        raw: response,
      });
    }

    throw new SantimPayDeclinedError(code, message, { ...context, raw: response });
  }
}

function assertNonEmpty(value: string | undefined, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SantimPayConfigError(`${field} is required and must be a non-empty string`);
  }
}

function assertHttps(url: string, field: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SantimPayConfigError(`${field} is not a valid URL: "${url}"`);
  }
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !isLocal) {
    throw new SantimPayConfigError(
      `${field} must be HTTPS (received "${url}"). SantimPay will not deliver callbacks to plaintext endpoints, and a payment callback over HTTP is tamperable in transit.`,
    );
  }
}

function tryNormalize(value: string): string {
  try {
    return normalizeEthiopianMsisdn(value);
  } catch {
    return value;
  }
}
