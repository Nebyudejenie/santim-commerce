/**
 * Unit test — pure logic, no database. The properties that matter most:
 * a naive `line.split(",")` gets these wrong, so this file exists to
 * prove the real parser doesn't — quoted fields containing commas,
 * embedded newlines, and escaped quotes are the cases a real seller's
 * spreadsheet export will actually contain.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv, parseCsvWithHeader, writeCsv } from "./csv.ts";

test("parses a simple, unquoted CSV", () => {
  const rows = parseCsv("a,b,c\n1,2,3");
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
});

test("a quoted field containing a comma is not split — the exact case a naive line.split(',') gets wrong", () => {
  const rows = parseCsv('title,price\n"Cotton Tee, Blue",499.00');
  assert.deepEqual(rows, [
    ["title", "price"],
    ["Cotton Tee, Blue", "499.00"],
  ]);
});

test("a quoted field containing an embedded newline is one field, not two rows", () => {
  const rows = parseCsv('title,description\n"Tee","Line one\nLine two"');
  assert.deepEqual(rows, [
    ["title", "description"],
    ["Tee", "Line one\nLine two"],
  ]);
});

test("an escaped double-quote inside a quoted field becomes a literal quote", () => {
  const rows = parseCsv('title\n"A 6"" hem"');
  assert.deepEqual(rows, [["title"], ['A 6" hem']]);
});

test("a file with no trailing newline still parses its last row", () => {
  const rows = parseCsv("a,b\n1,2");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1], ["1", "2"]);
});

test("blank lines are dropped, not returned as a phantom empty row", () => {
  const rows = parseCsv("a,b\n1,2\n\n3,4\n");
  assert.equal(rows.length, 3);
});

test("parseCsvWithHeader maps each row to its real header keys, trimmed", () => {
  const records = parseCsvWithHeader("title, sku \nCotton Tee,TEE-001\nWool Sweater,SWT-002");
  assert.deepEqual(records, [
    { title: "Cotton Tee", sku: "TEE-001" },
    { title: "Wool Sweater", sku: "SWT-002" },
  ]);
});

test("parseCsvWithHeader on a header-only file returns zero rows, not one row of empty strings", () => {
  const records = parseCsvWithHeader("title,sku\n");
  assert.equal(records.length, 0);
});

test("writeCsv only quotes a field when it actually needs quoting", () => {
  const csv = writeCsv(["title", "price"], [["Cotton Tee", "499.00"]]);
  assert.equal(csv, "title,price\nCotton Tee,499.00");
});

test("writeCsv quotes and escapes a field containing a comma, newline, or quote", () => {
  const csv = writeCsv(["title"], [['A 6" hem, blue']]);
  assert.equal(csv, 'title\n"A 6"" hem, blue"');
});

test("writeCsv output round-trips back through parseCsv unchanged", () => {
  const original = [
    ["Cotton Tee, Blue", 'A soft 6" hem\nwith a raw edge', "499.00"],
    ["Plain Item", "no special characters here", "100.00"],
  ];
  const csv = writeCsv(["title", "description", "priceBirr"], original);
  const parsed = parseCsv(csv);
  assert.deepEqual(parsed.slice(1), original);
});
