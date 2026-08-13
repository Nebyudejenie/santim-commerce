/**
 * Webhook verification.
 *
 * SantimPay POSTs the transaction to our `notifyUrl` with header
 * `Signed-Token`: a JWS signed with the key we handed over at onboarding.
 *
 * A verified signature is necessary but NOT sufficient authority to release
 * goods, for two reasons:
 *
 *   1. SantimPay holds the same private key we do, so a signature identifies
 *      "someone with the key", not "SantimPay specifically". There is no
 *      non-repudiation in this scheme.
 *   2. Even a genuine callback can be replayed, reordered, or delivered twice.
 *
 * So the rule is: verify signature → verify the body agrees with the token →
 * verify the amount matches what we recorded → THEN confirm against the
 * Transaction Status API before fulfilment. Defence in depth, because the
 * failure mode is shipping goods nobody paid for.
 */

import { derivePublicKey, verifyES256 } from "./crypto.js";
import { SantimPaySignatureError } from "./errors.js";
import { normalizeTransaction, type Transaction, type WireTransaction } from "./types.js";

/** The header SantimPay uses. Compared case-insensitively. */
export const SIGNATURE_HEADER = "signed-token";

export interface WebhookVerificationInput {
  /**
   * The RAW request body, exactly as received — a string or Buffer, never a
   * re-serialised object. `JSON.parse` then `JSON.stringify` can reorder keys
   * and change number formatting, which breaks any body-bound check and is a
   * classic source of "signature valid in Postman, invalid in production".
   */
  readonly rawBody: string | Buffer;
  /** Request headers (any case). */
  readonly headers: Record<string, string | string[] | undefined>;
  /** Our EC private key PEM; the public key is derived from it. */
  readonly privateKeyPem: string;
  /** Reject callbacks older than this. Default 5 minutes. */
  readonly maxAgeSeconds?: number;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

export interface VerifiedWebhook {
  readonly transaction: Transaction;
  /** Claims carried inside the signed token itself. */
  readonly tokenClaims: Record<string, unknown>;
}

export function extractSignatureHeader(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SIGNATURE_HEADER) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

/**
 * Verify and parse a SantimPay callback. Throws `SantimPaySignatureError` on
 * any failure — the caller should answer 401 and alert, never 200.
 */
export function verifyWebhook(input: WebhookVerificationInput): VerifiedWebhook {
  const token = extractSignatureHeader(input.headers);
  if (!token) {
    throw new SantimPaySignatureError(`missing "${SIGNATURE_HEADER}" header`);
  }

  const bodyText = typeof input.rawBody === "string" ? input.rawBody : input.rawBody.toString("utf8");

  let body: WireTransaction;
  try {
    body = JSON.parse(bodyText) as WireTransaction;
  } catch {
    throw new SantimPaySignatureError("request body is not valid JSON");
  }

  const publicKeyPem = derivePublicKey(input.privateKeyPem);
  const claims = verifyES256(token, publicKeyPem, {
    maxAgeSeconds: input.maxAgeSeconds ?? 300,
    now: input.now,
  });

  // Bind the signature to THIS body. Without this check an attacker who
  // captured any valid signed token could attach it to a body of their
  // choosing — a "1 birr" signature replayed onto a "50,000 birr" order.
  assertClaimAgrees(claims, body, ["txnId", "thirdPartyId"]);

  return { transaction: normalizeTransaction(body), tokenClaims: claims };
}

function assertClaimAgrees(
  claims: Record<string, unknown>,
  body: WireTransaction,
  fields: readonly string[],
): void {
  for (const field of fields) {
    const claimValue = claims[field];
    const bodyValue = body[field];
    // Only compare fields the token actually asserts; SantimPay's token body
    // is not documented field-for-field, so absence is not a failure.
    if (claimValue === undefined || claimValue === null) continue;
    if (String(claimValue) !== String(bodyValue)) {
      throw new SantimPaySignatureError(
        `signed token disagrees with body on "${field}" (token=${String(claimValue)}, body=${String(bodyValue)})`,
      );
    }
  }
}

/**
 * The amount check every integration forgets.
 *
 * Compare the callback's amount against the amount WE recorded when creating
 * the intent. A mismatch means either a gateway bug or an attacker, and both
 * warrant a hard stop plus an alert — never a silent fulfilment.
 */
export function assertAmountMatches(
  transaction: Transaction,
  expectedSantim: number,
): void {
  if (transaction.amountSantim !== expectedSantim) {
    throw new SantimPaySignatureError(
      `amount mismatch for ${transaction.merchantTransactionId}: callback reported ${transaction.amountSantim} santim, we recorded ${expectedSantim} santim`,
    );
  }
}
