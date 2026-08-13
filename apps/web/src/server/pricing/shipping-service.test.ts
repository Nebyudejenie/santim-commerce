import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateShipping,
  FREE_SHIPPING_THRESHOLD_SANTIM,
  isValidShippingZone,
  SHIPPING_ZONES,
} from "./shipping-service.ts";
import { santim } from "@santim/santimpay/money";

test("Addis Ababa is cheaper than regional, below the free-shipping threshold", () => {
  const subtotal = santim(50_000); // well under the free threshold
  const addis = calculateShipping("ADDIS_ABABA", subtotal);
  const regional = calculateShipping("REGIONAL", subtotal);
  assert.equal(addis, 15_000);
  assert.equal(regional, 35_000);
  assert.ok(addis < regional);
});

test("orders at or above the free-shipping threshold ship free, in either zone", () => {
  assert.equal(calculateShipping("ADDIS_ABABA", FREE_SHIPPING_THRESHOLD_SANTIM), 0);
  assert.equal(calculateShipping("REGIONAL", FREE_SHIPPING_THRESHOLD_SANTIM), 0);
  assert.equal(calculateShipping("REGIONAL", santim(FREE_SHIPPING_THRESHOLD_SANTIM + 1)), 0);
});

test("just below the threshold still charges shipping", () => {
  assert.equal(calculateShipping("ADDIS_ABABA", santim(FREE_SHIPPING_THRESHOLD_SANTIM - 1)), 15_000);
});

test("isValidShippingZone rejects anything not in the enumerated set", () => {
  assert.equal(isValidShippingZone("ADDIS_ABABA"), true);
  assert.equal(isValidShippingZone("REGIONAL"), true);
  assert.equal(isValidShippingZone("addis_ababa"), false); // case-sensitive, no silent coercion
  assert.equal(isValidShippingZone("MARS"), false);
  assert.equal(isValidShippingZone(""), false);
});

test("the zone list exposed to the UI matches the rate table's keys exactly", () => {
  const values = SHIPPING_ZONES.map((z) => z.value).sort();
  assert.deepEqual(values, ["ADDIS_ABABA", "REGIONAL"]);
});
