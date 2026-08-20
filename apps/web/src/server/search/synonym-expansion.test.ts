import test from "node:test";
import assert from "node:assert/strict";
import { expandSynonyms } from "./synonym-expansion.ts";

test("a recognized term expands to an OR group across its whole synonym set", () => {
  assert.equal(expandSynonyms("tv"), "tv OR television");
  assert.equal(expandSynonyms("phone"), "phone OR smartphone OR mobile");
});

test("matching is case-insensitive and trims whitespace", () => {
  assert.equal(expandSynonyms("  TV  "), "tv OR television");
  assert.equal(expandSynonyms("Phone"), "phone OR smartphone OR mobile");
});

test("an unrecognized term passes through unchanged", () => {
  assert.equal(expandSynonyms("essential tee crew neck"), "essential tee crew neck");
  assert.equal(expandSynonyms("hoodie"), "hoodie");
});

test("a multi-word query is never expanded, even if it contains a known term", () => {
  assert.equal(expandSynonyms("black tv stand"), "black tv stand");
});

test("an empty or whitespace-only query returns empty, not a group", () => {
  assert.equal(expandSynonyms(""), "");
  assert.equal(expandSynonyms("   "), "");
});
