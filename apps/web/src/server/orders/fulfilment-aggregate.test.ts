import test from "node:test";
import assert from "node:assert/strict";
import { deriveOrderFulfilmentStatus } from "./fulfilment-aggregate.ts";

test("all lines unfulfilled -> UNFULFILLED", () => {
  assert.equal(deriveOrderFulfilmentStatus(["UNFULFILLED", "UNFULFILLED"]), "UNFULFILLED");
});

test("all lines fulfilled -> FULFILLED", () => {
  assert.equal(deriveOrderFulfilmentStatus(["FULFILLED", "FULFILLED"]), "FULFILLED");
});

test("mixed -> PARTIALLY_FULFILLED, the whole reason this exists", () => {
  assert.equal(deriveOrderFulfilmentStatus(["FULFILLED", "UNFULFILLED"]), "PARTIALLY_FULFILLED");
});

test("single-line order, that line fulfilled -> FULFILLED", () => {
  assert.equal(deriveOrderFulfilmentStatus(["FULFILLED"]), "FULFILLED");
});

test("RETURNED lines are excluded from the count, not counted as unfulfilled", () => {
  assert.equal(deriveOrderFulfilmentStatus(["FULFILLED", "RETURNED"]), "FULFILLED");
  assert.equal(deriveOrderFulfilmentStatus(["UNFULFILLED", "RETURNED"]), "UNFULFILLED");
  assert.equal(deriveOrderFulfilmentStatus(["FULFILLED", "UNFULFILLED", "RETURNED"]), "PARTIALLY_FULFILLED");
});

test("an order where every line was returned reports UNFULFILLED, not FULFILLED", () => {
  assert.equal(deriveOrderFulfilmentStatus(["RETURNED", "RETURNED"]), "UNFULFILLED");
});

test("no lines at all -> UNFULFILLED (defensive default, should never happen for a real order)", () => {
  assert.equal(deriveOrderFulfilmentStatus([]), "UNFULFILLED");
});
