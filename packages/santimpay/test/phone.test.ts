import test from "node:test";
import assert from "node:assert/strict";
import {
  isValidEthiopianMsisdn, maskMsisdn, normalizeEthiopianMsisdn, PhoneNumberError,
} from "../src/phone.js";

test("normalises every format a customer might type", () => {
  const expected = "+251912345678";
  for (const input of [
    "0912345678",
    "912345678",
    "251912345678",
    "+251912345678",
    "+251 91 234 5678",
    "0912-345-678",
    "00251912345678",
    " +251912345678 ",
    "(0)912345678".replace(/[()]/g, ""),
  ]) {
    assert.equal(normalizeEthiopianMsisdn(input), expected, `failed for "${input}"`);
  }
});

test("accepts Safaricom Ethiopia 07 prefixes", () => {
  assert.equal(normalizeEthiopianMsisdn("0712345678"), "+251712345678");
});

test("rejects rather than guesses", () => {
  assert.throws(() => normalizeEthiopianMsisdn(""), PhoneNumberError);
  assert.throws(() => normalizeEthiopianMsisdn("091234567"), PhoneNumberError);   // too short
  assert.throws(() => normalizeEthiopianMsisdn("09123456789"), PhoneNumberError); // too long
  assert.throws(() => normalizeEthiopianMsisdn("0112345678"), PhoneNumberError);  // landline prefix
  assert.throws(() => normalizeEthiopianMsisdn("+14155552671"), PhoneNumberError); // not ET
});

test("isValid does not throw", () => {
  assert.equal(isValidEthiopianMsisdn("0912345678"), true);
  assert.equal(isValidEthiopianMsisdn("nope"), false);
});

test("masks for logs", () => {
  assert.equal(maskMsisdn("+251912345678"), "+2519****5678");
});
