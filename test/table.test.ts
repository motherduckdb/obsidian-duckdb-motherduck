import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  escapeCell,
  normalizedCellCharCap,
  normalizedRowCap,
  renderMarkdownTable,
  simpleHash,
  truncateString,
} from "../src/table";

test("escapeCell produces markdown-safe table cells", () => {
  assert.equal(escapeCell("a|b\nc\\d\r"), "a\\|b c\\\\d");
  assert.equal(escapeCell(null), "");
  assert.equal(escapeCell({ nested: true }), "{\"nested\":true}");
});

test("normalizedRowCap falls back and clamps large values", () => {
  assert.equal(normalizedRowCap(0), 100);
  assert.equal(normalizedRowCap(Number.NaN), 100);
  assert.equal(normalizedRowCap(2.8), 2);
  assert.equal(normalizedRowCap(20000), 10000);
});

test("normalizedCellCharCap falls back and clamps large values", () => {
  assert.equal(normalizedCellCharCap(0), 80);
  assert.equal(normalizedCellCharCap(Number.NaN), 80);
  assert.equal(normalizedCellCharCap(15.7), 15);
  assert.equal(normalizedCellCharCap(50000), 10000);
});

test("truncateString slices to cap-1 chars and appends an ellipsis", () => {
  assert.equal(truncateString("hello", 10), "hello");
  assert.equal(truncateString("abcdefghij", 10), "abcdefghij");
  assert.equal(truncateString("abcdefghijk", 10), "abcdefghi…");
  assert.equal(truncateString("a really long sentence", 10), "a really …");
});

test("escapeCell truncates long values before escaping", () => {
  const long = "a".repeat(200);
  const out = escapeCell(long, 20);
  assert.equal(out.length, 20);
  assert.ok(out.endsWith("…"));
});

test("renderMarkdownTable includes connection-aware hash and escaped headers", () => {
  const sql = "select 1 as \"a|b\"";
  const rendered = renderMarkdownTable(
    [{ "a|b": "x|y" }],
    ["a|b"],
    sql,
    "local",
    100,
  );

  assert.match(rendered, new RegExp(`hash=${simpleHash(`local\n${sql}`)}`));
  assert.match(rendered, /conn=local/);
  assert.match(rendered, /\| a\\\|b \|/);
  assert.match(rendered, /\| x\\\|y \|/);
});

test("renderMarkdownTable keeps schema visible for zero-row results", () => {
  const rendered = renderMarkdownTable([], ["name", "count"], "select * from empty", "cloud", 100);

  assert.match(rendered, /\| name \| count \|/);
  assert.match(rendered, /> 0 rows/);
});

test("renderMarkdownTable truncates rendered rows at the row cap", () => {
  const rendered = renderMarkdownTable(
    [{ x: 1 }, { x: 2 }, { x: 3 }],
    ["x"],
    "select x from t",
    "local",
    2,
  );

  assert.match(rendered, /\| 1 \|/);
  assert.match(rendered, /\| 2 \|/);
  assert.doesNotMatch(rendered, /\| 3 \|/);
  assert.match(rendered, /1 more rows hidden \(cap 2\)/);
});

test("renderMarkdownTable truncates long cell values per cellCharCap", () => {
  const long = "x".repeat(200);
  const rendered = renderMarkdownTable(
    [{ note: long }],
    ["note"],
    "select note from t",
    "local",
    100,
    25,
  );

  const cellLine = rendered.split("\n").find((l) => l.startsWith("| x")) ?? "";
  assert.ok(cellLine.includes("…"), "expected ellipsis in truncated cell line");
  assert.ok(!cellLine.includes("x".repeat(100)), "expected no full long value");
});
