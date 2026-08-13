import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import {
  derivePublicKey, generateTestKeyPair, signES256, timingSafeEqual, verifyES256,
} from "../src/crypto.js";
import { SantimPayConfigError, SantimPaySignatureError } from "../src/errors.js";

const { privateKey, publicKey } = generateTestKeyPair();

test("sign/verify round-trips", () => {
  const payload = { amount: 100, paymentReason: "coffee", merchantId: "m-1", generated: 1_700_000_000 };
  const token = signES256(payload, privateKey);
  assert.deepEqual(verifyES256(token, publicKey), payload);
});

test("signing does NOT inject an iat claim", () => {
  // jsonwebtoken adds `iat` when handed an object. SantimPay reconstructs the
  // expected body server-side, so the extra claim breaks verification and
  // returns {"message":"Invalid token"}. Passing a JSON string prevents it.
  const token = signES256({ amount: 1, generated: 123 }, privateKey);
  const decoded = jwt.decode(token, { json: false }) as unknown;
  const claims = typeof decoded === "string" ? JSON.parse(decoded) : decoded;
  assert.deepEqual(Object.keys(claims as object).sort(), ["amount", "generated"]);
});

test("public key derived from our private key verifies the signature", () => {
  const derived = derivePublicKey(privateKey);
  const token = signES256({ txnId: "abc" }, privateKey);
  assert.deepEqual(verifyES256(token, derived), { txnId: "abc" });
});

test("a token signed by a different key is rejected", () => {
  const attacker = generateTestKeyPair();
  const forged = signES256({ txnId: "abc", amount: 999999 }, attacker.privateKey);
  assert.throws(() => verifyES256(forged, publicKey), SantimPaySignatureError);
});

test("a tampered payload is rejected", () => {
  const token = signES256({ amount: 1 }, privateKey);
  const [header, , signature] = token.split(".");
  const swapped = Buffer.from(JSON.stringify({ amount: 1_000_000 })).toString("base64url");
  assert.throws(() => verifyES256(`${header}.${swapped}.${signature}`, publicKey), SantimPaySignatureError);
});

test("algorithm confusion: alg=none is rejected", () => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ amount: 999_999 })).toString("base64url");
  assert.throws(() => verifyES256(`${header}.${body}.`, publicKey), SantimPaySignatureError);
});

test("algorithm confusion: HS256 signed with the public key is rejected", () => {
  // The classic escalation — the public key is not secret, so if the verifier
  // trusts the token's own `alg` header an attacker can mint valid HMACs.
  const forged = jwt.sign(JSON.stringify({ amount: 999_999 }), publicKey, { algorithm: "HS256" });
  assert.throws(() => verifyES256(forged, publicKey), SantimPaySignatureError);
});

test("freshness window bounds replay", () => {
  const nowSeconds = 1_700_000_000;
  const fresh = signES256({ txnId: "a", generated: nowSeconds - 10 }, privateKey);
  const stale = signES256({ txnId: "a", generated: nowSeconds - 3600 }, privateKey);
  const now = () => nowSeconds * 1000;

  assert.ok(verifyES256(fresh, publicKey, { maxAgeSeconds: 300, now }));
  assert.throws(
    () => verifyES256(stale, publicKey, { maxAgeSeconds: 300, now }),
    /3600s old/,
  );
});

test("a token from the future is rejected", () => {
  const nowSeconds = 1_700_000_000;
  const future = signES256({ txnId: "a", generated: nowSeconds + 600 }, privateKey);
  assert.throws(
    () => verifyES256(future, publicKey, { maxAgeSeconds: 300, now: () => nowSeconds * 1000 }),
    /in the future/,
  );
});

test("freshness cannot be enforced without a timestamp", () => {
  const token = signES256({ txnId: "a" }, privateKey);
  assert.throws(() => verifyES256(token, publicKey, { maxAgeSeconds: 300 }), /no timestamp/);
});

test("an RSA key is rejected with a clear message", () => {
  const { privateKey: rsa } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  assert.throws(() => derivePublicKey(rsa), SantimPayConfigError);
});

test("timingSafeEqual behaves like equality", () => {
  assert.equal(timingSafeEqual("secret", "secret"), true);
  assert.equal(timingSafeEqual("secret", "secrat"), false);
  assert.equal(timingSafeEqual("secret", "secretlonger"), false);
  assert.equal(timingSafeEqual("", ""), true);
});
