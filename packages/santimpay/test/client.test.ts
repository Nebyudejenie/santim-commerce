import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { SantimPayClient } from "../src/client.js";
import { generateTestKeyPair } from "../src/crypto.js";
import {
  DuplicateReferenceError, SantimPayConfigError, SantimPayDeclinedError,
  SantimPayHttpError, SantimPayTimeoutError,
} from "../src/errors.js";
import { birr } from "../src/money.js";

const { privateKey, publicKey } = generateTestKeyPair();
const MERCHANT_ID = "9e2dab64-e2bb-4837-9b85-d855dd878d2b";

interface Call { url: string; init: RequestInit }

/** Records every outbound call and replies with a scripted queue of responses. */
function mockFetch(responses: Array<{ status?: number; body: unknown } | Error>) {
  const calls: Call[] = [];
  const queue = [...responses];
  const impl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init as RequestInit });
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { impl, calls };
}

function makeClient(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return new SantimPayClient({
    merchantId: MERCHANT_ID,
    privateKey,
    environment: "testbed",
    fetchImpl,
    sleep: async () => {},           // no real delays in tests
    ...overrides,
  });
}

function bodyOf(call: Call): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function claimsOf(token: string): Record<string, unknown> {
  const decoded = jwt.verify(token, publicKey, { algorithms: ["ES256"] });
  return typeof decoded === "string" ? JSON.parse(decoded) : (decoded as Record<string, unknown>);
}

const CHECKOUT = {
  transactionId: "01HQ8ZM5ABCDEF",
  amount: birr(19.99),
  reason: "Order 01HQ8ZM5",
  successRedirectUrl: "https://shop.example.et/checkout/success",
  failureRedirectUrl: "https://shop.example.et/checkout/failed",
  notifyUrl: "https://shop.example.et/api/webhooks/santimpay",
};

/* ------------------------------------------------------------------ config */

test("production without a gateway token fails fast at construction", () => {
  assert.throws(
    () => new SantimPayClient({ merchantId: MERCHANT_ID, privateKey, environment: "production" }),
    SantimPayConfigError,
  );
});

test("a non-PEM private key is rejected with actionable guidance", () => {
  assert.throws(
    () => new SantimPayClient({ merchantId: MERCHANT_ID, privateKey: "bm90LWEta2V5", environment: "testbed" }),
    /base64/,
  );
});

test("a plaintext notifyUrl is rejected", async () => {
  const { impl } = mockFetch([{ body: { url: "https://pay" } }]);
  await assert.rejects(
    makeClient(impl).createCheckoutSession({ ...CHECKOUT, notifyUrl: "http://shop.example.et/hook" }),
    /must be HTTPS/,
  );
});

/* ---------------------------------------------------------------- checkout */

test("createCheckoutSession posts a correctly signed payload", async () => {
  const { impl, calls } = mockFetch([{ body: { url: "https://testnet.santimpay.com/pay/abc" } }]);
  const client = makeClient(impl);

  const { paymentUrl } = await client.createCheckoutSession(CHECKOUT);
  assert.equal(paymentUrl, "https://testnet.santimpay.com/pay/abc");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://testnet.santimpay.com/api/v1/gateway/initiate-payment");

  const payload = bodyOf(calls[0]!);
  assert.equal(payload["id"], CHECKOUT.transactionId);
  assert.equal(payload["amount"], 19.99);          // major units on the wire
  assert.equal(payload["merchantId"], MERCHANT_ID);
  assert.equal(payload["notifyUrl"], CHECKOUT.notifyUrl);
  // cancelRedirectUrl defaults to the failure URL rather than being dropped
  assert.equal(payload["cancelRedirectUrl"], CHECKOUT.failureRedirectUrl);

  const claims = claimsOf(String(payload["signedToken"]));
  assert.deepEqual(Object.keys(claims).sort(), ["amount", "generated", "merchantId", "paymentReason"]);
  assert.equal(claims["amount"], 19.99);
  assert.equal(claims["paymentReason"], CHECKOUT.reason);
  assert.equal(claims["merchantId"], MERCHANT_ID);
});

test("phone numbers are normalised before they reach the gateway", async () => {
  const { impl, calls } = mockFetch([{ body: { url: "https://pay" } }]);
  await makeClient(impl).createCheckoutSession({ ...CHECKOUT, phoneNumber: "0912345678" });
  assert.equal(bodyOf(calls[0]!)["phoneNumber"], "+251912345678");
});

test("the gateway bearer token is sent (the vendor SDK omits it)", async () => {
  const { impl, calls } = mockFetch([{ body: { url: "https://pay" } }]);
  const client = makeClient(impl, { gatewayToken: "gw-token-123" });
  await client.createCheckoutSession(CHECKOUT);

  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers["Authorization"], "Bearer gw-token-123");
});

/* ----------------------------------------------------------- declines/errors */

test("HTTP 200 with status=declined is an error, not a success", async () => {
  // This is the failure mode that silently ships goods: the vendor SDK checks
  // only `response.status === 200` and returns the body as if it succeeded.
  const { impl } = mockFetch([{ body: { status: "declined", message: "Invalid token" } }]);
  await assert.rejects(makeClient(impl).createCheckoutSession(CHECKOUT), (err: unknown) => {
    assert.ok(err instanceof SantimPayDeclinedError);
    assert.equal(err.code, "INVALID_TOKEN");
    assert.equal(err.retryable, false);
    return true;
  });
});

test("every documented decline message maps to a stable code", async () => {
  const cases: Array<[string, string]> = [
    ["phone number must be in the format +251912345678", "INVALID_PHONE_NUMBER"],
    ['ERROR: new row for relation "santimpay_wallets" violates check constraint "chk_santimpay_wallets_balance_is_non_negative" (SQLSTATE 23514)', "INSUFFICIENT_MERCHANT_BALANCE"],
    ["Payment Method Not Supported", "PAYMENT_METHOD_NOT_SUPPORTED"],
    ["Invalid token", "INVALID_TOKEN"],
    ["crypto/ecdsa: verification error", "SIGNATURE_VERIFICATION_FAILED"],
  ];

  for (const [message, expected] of cases) {
    const { impl } = mockFetch([{ body: { status: "declined", message } }]);
    await assert.rejects(makeClient(impl).createCheckoutSession(CHECKOUT), (err: unknown) => {
      assert.ok(err instanceof SantimPayDeclinedError, `expected decline for "${message}"`);
      assert.equal(err.code, expected, `wrong code for "${message}"`);
      return true;
    });
  }
});

test("a duplicate reference is its own error type, not a generic failure", async () => {
  // A safe retry of an already-accepted payment lands here. Treating it as a
  // failure would tell a customer who HAS paid that they have not.
  const { impl } = mockFetch([{ body: { status: "declined", message: "Duplicate Client Reference." } }]);
  await assert.rejects(makeClient(impl).createCheckoutSession(CHECKOUT), (err: unknown) => {
    assert.ok(err instanceof DuplicateReferenceError);
    assert.match(err.message, /fetchTransactionStatus/);
    return true;
  });
});

/* -------------------------------------------------------------- resilience */

test("transient 5xx is retried and then succeeds", async () => {
  const { impl, calls } = mockFetch([
    { status: 502, body: { message: "bad gateway" } },
    { status: 502, body: { message: "bad gateway" } },
    { body: { url: "https://pay/ok" } },
  ]);
  const seen: number[] = [];
  const client = makeClient(impl, { onRetry: (i: { attempt: number }) => seen.push(i.attempt) });

  const { paymentUrl } = await client.createCheckoutSession(CHECKOUT);
  assert.equal(paymentUrl, "https://pay/ok");
  assert.equal(calls.length, 3);
  assert.deepEqual(seen, [1, 2]);
});

test("retries are bounded, not infinite", async () => {
  const { impl, calls } = mockFetch([{ status: 500, body: { message: "boom" } }]);
  await assert.rejects(makeClient(impl).createCheckoutSession(CHECKOUT), SantimPayHttpError);
  assert.equal(calls.length, 3); // 1 initial + DEFAULT_RETRY.maxRetries (2)
});

test("a 4xx is not retried — repeating a rejected request only burns budget", async () => {
  const { impl, calls } = mockFetch([{ status: 400, body: { message: "bad request" } }]);
  await assert.rejects(makeClient(impl).createCheckoutSession(CHECKOUT), SantimPayHttpError);
  assert.equal(calls.length, 1);
});

test("a hung connection hits our deadline instead of hanging forever", async () => {
  const impl: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      (init as RequestInit).signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });

  const client = makeClient(impl, { timeoutMs: 20, retry: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 1 } });
  await assert.rejects(client.createCheckoutSession(CHECKOUT), (err: unknown) => {
    assert.ok(err instanceof SantimPayTimeoutError);
    // The message must warn that the request may still have been processed —
    // "timeout" is not "did not happen".
    assert.match(err.message, /may still have been processed/);
    return true;
  });
});

/* ------------------------------------------------------------ status check */

test("fetchTransactionStatus signs with merId, not merchantId", async () => {
  // Documented in the Additional integration document. Using `merchantId`
  // here yields "crypto/ecdsa: verification error".
  const { impl, calls } = mockFetch([{
    body: {
      txnId: "txn-1", thirdPartyId: "01HQ8ZM5ABCDEF", amount: "19.99",
      commission: "0.5", totalAmount: "20.49", status: "COMPLETED",
      paymentVia: "Telebirr", refId: "bank-ref-1", currency: "ETB",
    },
  }]);

  const tx = await makeClient(impl).fetchTransactionStatus("01HQ8ZM5ABCDEF");

  const payload = bodyOf(calls[0]!);
  assert.equal(payload["fullParam"], true);
  assert.equal(payload["merchantId"], MERCHANT_ID);

  const claims = claimsOf(String(payload["signedToken"]));
  assert.deepEqual(Object.keys(claims).sort(), ["generated", "id", "merId"]);
  assert.equal(claims["merId"], MERCHANT_ID);
  assert.equal(claims["merchantId"], undefined);

  assert.equal(tx.status, "COMPLETED");
  assert.equal(tx.amountSantim, 1999);
  assert.equal(tx.totalSantim, 2049);
  assert.equal(tx.channelReference, "bank-ref-1");
});

/* -------------------------------------------------------------------- B2C */

test("payout signs the right arguments (vendor SDK shifts them by one)", async () => {
  const { impl, calls } = mockFetch([{
    body: { txnId: "payout-1", thirdPartyId: "REFUND-1", amount: "0.5", status: "SUCCESS", transactionType: "GATEWAY_PAYOUT" },
  }]);

  const tx = await makeClient(impl).payout({
    transactionId: "REFUND-1",
    amount: birr(0.5),
    reason: "Refund for order 01HQ8ZM5",
    receiverAccountNumber: "0932118929",
    paymentMethod: "Telebirr",
    notifyUrl: "https://shop.example.et/api/webhooks/santimpay",
  });

  const payload = bodyOf(calls[0]!);
  assert.equal(payload["receiverAccountNumber"], "+251932118929");
  assert.equal(payload["clientReference"], "REFUND-1");

  const claims = claimsOf(String(payload["signedToken"]));
  // The vendor bug puts merchantId into paymentMethod and paymentMethod into
  // phoneNumber. These assertions fail against the unpatched SDK.
  assert.equal(claims["paymentMethod"], "Telebirr");
  assert.equal(claims["phoneNumber"], "+251932118929");
  assert.equal(claims["merchantId"], MERCHANT_ID);
  assert.equal(claims["amount"], 0.5);

  assert.equal(tx.type, "payout");
  assert.equal(tx.status, "COMPLETED"); // SUCCESS normalised
});

test("insufficient escrow surfaces as a business-actionable code", async () => {
  const { impl } = mockFetch([{
    body: {
      status: "declined",
      message: 'ERROR: new row for relation "santimpay_wallets" violates check constraint "chk_santimpay_wallets_balance_is_non_negative" (SQLSTATE 23514)',
    },
  }]);

  await assert.rejects(
    makeClient(impl).payout({
      transactionId: "REFUND-2", amount: birr(1000), reason: "refund",
      receiverAccountNumber: "0932118929", paymentMethod: "Telebirr",
      notifyUrl: "https://shop.example.et/api/webhooks/santimpay",
    }),
    (err: unknown) => {
      assert.ok(err instanceof SantimPayDeclinedError);
      assert.equal(err.code, "INSUFFICIENT_MERCHANT_BALANCE");
      return true;
    },
  );
});
