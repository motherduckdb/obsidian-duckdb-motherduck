import { strict as assert } from "node:assert";
import { test } from "node:test";
import { escapeCell, normalizedRowCap, renderMarkdownTable, simpleHash } from "../src/table";

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
