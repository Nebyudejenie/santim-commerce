/**
 * ES256 signing and verification.
 *
 * SantimPay authenticates every request with a compact JWS signed using ECDSA
 * P-256 + SHA-256 (`ES256`), and signs its webhook callbacks with the SAME
 * key — the merchant hands its private key over at onboarding. Consequences of
 * that design are analysed in docs/01-santimpay-protocol-spec.md §1.1.
 */

import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { SantimPayConfigError, SantimPaySignatureError } from "./errors.js";

/**
 * Sign a payload with ES256.
 *
 * CRITICAL: the payload is stringified before being handed to `jsonwebtoken`.
 * Passing an object makes the library inject an `iat` claim; SantimPay
 * reconstructs the expected body server-side, the extra claim breaks the
 * match, and you get `{"message":"Invalid token","status":"declined"}`.
 * The vendor SDK does this correctly and it is the one thing you must not
 * "clean up".
 */
export function signES256(payload: Record<string, unknown>, privateKeyPem: string): string {
  try {
    return jwt.sign(JSON.stringify(payload), privateKeyPem, { algorithm: "ES256" });
  } catch (err) {
    throw new SantimPayConfigError(
      `Failed to sign payload with ES256 — check that SANTIMPAY_PRIVATE_KEY is a valid EC P-256 private key in PEM form. ${(err as Error).message}`,
    );
  }
}

/**
 * Derive the public key from our EC private key. Used to verify the callback
 * signature, because the callback is signed with the key we gave SantimPay.
 */
export function derivePublicKey(privateKeyPem: string): string {
  try {
    const keyObject = crypto.createPrivateKey(privateKeyPem);
    if (keyObject.asymmetricKeyType !== "ec") {
      throw new Error(`expected an EC key, found "${keyObject.asymmetricKeyType}"`);
    }
    return crypto
      .createPublicKey(keyObject)
      .export({ type: "spki", format: "pem" })
      .toString();
  } catch (err) {
    throw new SantimPayConfigError(
      `Cannot derive a public key from the configured private key: ${(err as Error).message}`,
    );
  }
}

export interface VerifyOptions {
  /**
   * Reject tokens older than this. Bounds the replay window: a signature
   * captured off the wire stops being useful after it expires.
   */
  readonly maxAgeSeconds?: number;
  /** Injectable clock, so freshness logic is testable without waiting. */
  readonly now?: () => number;
}

/**
 * Verify an ES256 JWS and return its decoded payload.
 *
 * `algorithms: ["ES256"]` is pinned deliberately. Accepting the algorithm
 * declared in the token's own header is the classic JWT confusion attack: an
 * attacker sets `alg: "none"`, or switches to HS256 and signs with the public
 * key as the HMAC secret. Never let the token choose how it is verified.
 */
export function verifyES256(
  token: string,
  publicKeyPem: string,
  options: VerifyOptions = {},
): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, publicKeyPem, {
      algorithms: ["ES256"],
      // The payload is an opaque JSON string, so registered-claim validation
      // does not apply; we enforce freshness ourselves below.
      ignoreExpiration: true,
    });
  } catch (err) {
    throw new SantimPaySignatureError((err as Error).message);
  }

  let payload: Record<string, unknown>;
  if (typeof decoded === "string") {
    try {
      payload = JSON.parse(decoded) as Record<string, unknown>;
    } catch {
      throw new SantimPaySignatureError("signed payload is not valid JSON");
    }
  } else if (decoded && typeof decoded === "object") {
    payload = decoded as Record<string, unknown>;
  } else {
    throw new SantimPaySignatureError("signed payload has an unexpected shape");
  }

  const maxAge = options.maxAgeSeconds;
  if (maxAge !== undefined) {
    const generated = extractTimestampSeconds(payload);
    if (generated === undefined) {
      throw new SantimPaySignatureError(
        "token carries no timestamp claim, so freshness cannot be enforced",
      );
    }
    const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
    const age = nowSeconds - generated;
    // A small negative age is normal clock skew; a large one is suspicious.
    if (age > maxAge) {
      throw new SantimPaySignatureError(`token is ${age}s old, maximum allowed is ${maxAge}s`);
    }
    if (age < -60) {
      throw new SantimPaySignatureError(`token is timestamped ${-age}s in the future`);
    }
  }

  return payload;
}

function extractTimestampSeconds(payload: Record<string, unknown>): number | undefined {
  for (const key of ["generated", "iat", "timestamp"]) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      // Tolerate milliseconds, which some gateways send despite the spec.
      return value > 1e11 ? Math.floor(value / 1000) : value;
    }
  }
  return undefined;
}

/**
 * Constant-time string comparison, for any place we compare a secret.
 * `a === b` short-circuits on the first differing byte and therefore leaks
 * the length of the matching prefix through timing.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the length check itself is not a fast path.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Generate a P-256 keypair — for local development and tests only. */
export function generateTestKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKey, publicKey };
}
