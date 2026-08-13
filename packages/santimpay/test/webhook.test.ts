import test from "node:test";
import assert from "node:assert/strict";
import { generateTestKeyPair, signES256 } from "../src/crypto.js";
import { SantimPaySignatureError } from "../src/errors.js";
import { assertAmountMatches, verifyWebhook } from "../src/webhook.js";

const { privateKey } = generateTestKeyPair();
const NOW_SECONDS = 1_700_000_000;
const now = () => NOW_SECONDS * 1000;

const body = {
  txnId: "d7fa8146-cb58-405a-8ca7-920cdc1f56da",
  created_at: "2023-02-28T10:26:17.904879Z",
  updated_at: "2023-02-28T10:26:49.042602Z",
  thirdPartyId: "01HQ8ZM5",
  merId: "f660f84e-7395-417b-91ff-542026c38326",
  merName: "santim test company",
  amount: "19.99",
  commission: "0.50",
  currency: "ETB",
  reason: "Order 01HQ8ZM5",
  paymentVia: "Telebirr",
  refId: "5e4af4cc-99d1-4db9-a784-4ba4eb75e646",
  message: "payment successful",
  status: "COMPLETED",
};

function signedHeaders(payload: Record<string, unknown>) {
  return { "Signed-Token": signES256(payload, privateKey) };
}

const validClaims = {
  txnId: body.txnId,
  thirdPartyId: body.thirdPartyId,
  generated: NOW_SECONDS - 5,
};

test("verifies a well-formed callback and normalises it", () => {
  const { transaction } = verifyWebhook({
    rawBody: JSON.stringify(body),
    headers: signedHeaders(validClaims),
    privateKeyPem: privateKey,
    now,
  });

  assert.equal(transaction.status, "COMPLETED");
  assert.equal(transaction.merchantTransactionId, "01HQ8ZM5");
  assert.equal(transaction.gatewayTransactionId, body.txnId);
  assert.equal(transaction.amountSantim, 1999);
  assert.equal(transaction.commissionSantim, 50);
  assert.equal(transaction.totalSantim, 2049);
  assert.equal(transaction.channel, "Telebirr");
  assert.equal(transaction.channelReference, body.refId);
  assert.equal(transaction.type, "payment");
  assert.ok(transaction.createdAt instanceof Date);
});

test("header name matching is case-insensitive", () => {
  const result = verifyWebhook({
    rawBody: JSON.stringify(body),
    headers: { "signed-token": signES256(validClaims, privateKey) },
    privateKeyPem: privateKey,
    now,
  });
  assert.equal(result.transaction.status, "COMPLETED");
});

test("a missing signature header is rejected", () => {
  assert.throws(
    () => verifyWebhook({ rawBody: JSON.stringify(body), headers: {}, privateKeyPem: privateKey, now }),
    /missing "signed-token" header/,
  );
});

test("a callback signed with an attacker's key is rejected", () => {
  const attacker = generateTestKeyPair();
  assert.throws(
    () => verifyWebhook({
      rawBody: JSON.stringify(body),
      headers: { "Signed-Token": signES256(validClaims, attacker.privateKey) },
      privateKeyPem: privateKey,
      now,
    }),
    SantimPaySignatureError,
  );
});

test("a valid signature replayed onto a different body is rejected", () => {
  // The attack this defends against: capture a legitimate 1-birr callback,
  // then POST its signature with a body claiming a different transaction.
  const otherOrder = { ...body, thirdPartyId: "SOMEONE-ELSES-ORDER", amount: "50000.00" };
  assert.throws(
    () => verifyWebhook({
      rawBody: JSON.stringify(otherOrder),
      headers: signedHeaders(validClaims),
      privateKeyPem: privateKey,
      now,
    }),
    /disagrees with body on "thirdPartyId"/,
  );
});

test("a stale callback is rejected", () => {
  assert.throws(
    () => verifyWebhook({
      rawBody: JSON.stringify(body),
      headers: signedHeaders({ ...validClaims, generated: NOW_SECONDS - 7200 }),
      privateKeyPem: privateKey,
      maxAgeSeconds: 300,
      now,
    }),
    /old/,
  );
});

test("a non-JSON body is rejected before any crypto work", () => {
  assert.throws(
    () => verifyWebhook({
      rawBody: "<html>504 Gateway Timeout</html>",
      headers: signedHeaders(validClaims),
      privateKeyPem: privateKey,
      now,
    }),
    /not valid JSON/,
  );
});

test("B2C payouts are typed as payouts and SUCCESS maps to COMPLETED", () => {
  const payoutBody = {
    ...body,
    transactionType: "GATEWAY_PAYOUT",
    status: "SUCCESS",
    created_at: "2023-04-07 08:08:48.127080706 +0000 UTC",
    clientReference: "REFUND-01HQ8ZM5",
  };
  const { transaction } = verifyWebhook({
    rawBody: JSON.stringify(payoutBody),
    headers: signedHeaders(validClaims),
    privateKeyPem: privateKey,
    now,
  });
  assert.equal(transaction.type, "payout");
  assert.equal(transaction.status, "COMPLETED");
  assert.equal(transaction.clientReference, "REFUND-01HQ8ZM5");
  // Go's default time format must still parse.
  assert.ok(transaction.createdAt instanceof Date);
});

test("an unknown status fails safe to PENDING, never to COMPLETED", () => {
  const { transaction } = verifyWebhook({
    rawBody: JSON.stringify({ ...body, status: "SOMETHING_NEW" }),
    headers: signedHeaders(validClaims),
    privateKeyPem: privateKey,
    now,
  });
  assert.equal(transaction.status, "PENDING");
});

test("assertAmountMatches catches a callback that disagrees with our records", () => {
  const { transaction } = verifyWebhook({
    rawBody: JSON.stringify(body),
    headers: signedHeaders(validClaims),
    privateKeyPem: privateKey,
    now,
  });

  assert.doesNotThrow(() => assertAmountMatches(transaction, 1999));
  assert.throws(() => assertAmountMatches(transaction, 5000), /amount mismatch/);
});
