import test from "node:test";
import assert from "node:assert/strict";
import { hashPassword, needsRehash, PasswordError, verifyPassword } from "./password.ts";

test("hash/verify round-trips correctly", async () => {
  const hash = await hashPassword("correct-horse-battery-staple");
  assert.equal(await verifyPassword("correct-horse-battery-staple", hash), true);
});

test("a wrong password is rejected", async () => {
  const hash = await hashPassword("correct-horse-battery-staple");
  assert.equal(await verifyPassword("wrong-password-entirely", hash), false);
});

test("two hashes of the same password are different (random salt)", async () => {
  const a = await hashPassword("same-password-twice");
  const b = await hashPassword("same-password-twice");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("same-password-twice", a), true);
  assert.equal(await verifyPassword("same-password-twice", b), true);
});

test("rejects passwords shorter than 10 characters", async () => {
  await assert.rejects(hashPassword("short1"), PasswordError);
});

test("rejects absurdly long passwords (DoS guard, not a strength rule)", async () => {
  await assert.rejects(hashPassword("a".repeat(300)), PasswordError);
});

test("a garbage stored hash fails closed, never throws", async () => {
  assert.equal(await verifyPassword("anything", "not-a-real-hash"), false);
  assert.equal(await verifyPassword("anything", ""), false);
  assert.equal(await verifyPassword("anything", "scrypt$bad$params$here$$"), false);
});

test("needsRehash is false immediately after hashing under current params", async () => {
  const hash = await hashPassword("correct-horse-battery-staple");
  assert.equal(needsRehash(hash), false);
});

test("needsRehash is true for a hash under different parameters", () => {
  // Simulates an old hash from before a cost-parameter bump.
  const oldHash = "scrypt$8192$8$1$00000000000000000000000000000000$00";
  assert.equal(needsRehash(oldHash), true);
});

test("needsRehash is true for a malformed/foreign hash", () => {
  assert.equal(needsRehash("$2b$10$somebcrypthashthatisnotours"), true);
});

test("password normalization: NFKC-equivalent unicode verifies the same", async () => {
  // U+00E9 (single precomposed "e with acute accent") vs U+0065 U+0301
  // ("e" followed by a combining acute accent) — visually and semantically
  // the same password, and normalization is what keeps a user from being
  // locked out by which representation their keyboard/OS happened to
  // produce.
  //
  // Built from \u escapes, deliberately never typed as literal characters:
  // two visually-identical source strings can end up byte-identical on disk
  // depending on editor/tool normalization, which would make this test pass
  // even if hashPassword's `.normalize("NFKC")` call were deleted entirely.
  const composed = "café-security-1";
  const decomposed = "café-security-1";

  assert.notEqual(composed, decomposed); // sanity: genuinely different byte sequences
  assert.equal(composed.length, 15);
  assert.equal(decomposed.length, 16);
  assert.equal(composed.normalize("NFKC"), decomposed.normalize("NFKC")); // ...equal once normalized

  const hash = await hashPassword(composed);
  assert.equal(await verifyPassword(decomposed, hash), true);
});
