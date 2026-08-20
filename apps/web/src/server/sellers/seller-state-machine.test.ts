import test from "node:test";
import assert from "node:assert/strict";
import { canTransitionSeller } from "./seller-state-machine.ts";

test("PENDING can move to APPROVED or REJECTED, nothing else", () => {
  assert.equal(canTransitionSeller("PENDING", "APPROVED"), true);
  assert.equal(canTransitionSeller("PENDING", "REJECTED"), true);
  assert.equal(canTransitionSeller("PENDING", "SUSPENDED"), false);
  assert.equal(canTransitionSeller("PENDING", "PENDING"), false);
});

test("APPROVED can only move to SUSPENDED", () => {
  assert.equal(canTransitionSeller("APPROVED", "SUSPENDED"), true);
  assert.equal(canTransitionSeller("APPROVED", "PENDING"), false);
  assert.equal(canTransitionSeller("APPROVED", "REJECTED"), false);
});

test("SUSPENDED can only be reinstated to APPROVED", () => {
  assert.equal(canTransitionSeller("SUSPENDED", "APPROVED"), true);
  assert.equal(canTransitionSeller("SUSPENDED", "PENDING"), false);
  assert.equal(canTransitionSeller("SUSPENDED", "REJECTED"), false);
});

test("REJECTED is terminal — no transition out of it", () => {
  assert.equal(canTransitionSeller("REJECTED", "PENDING"), false);
  assert.equal(canTransitionSeller("REJECTED", "APPROVED"), false);
  assert.equal(canTransitionSeller("REJECTED", "SUSPENDED"), false);
});
