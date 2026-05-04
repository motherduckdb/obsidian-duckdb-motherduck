import { strict as assert } from "node:assert";
import { test } from "node:test";
import { shortPathLabel } from "../src/path";
import { isOverdue } from "../src/schedule";

test("isOverdue treats missing and invalid timestamps as due", () => {
  assert.equal(isOverdue("daily", null, Date.UTC(2026, 4, 4)), true);
  assert.equal(isOverdue("daily", "not a date", Date.UTC(2026, 4, 4)), true);
});

test("isOverdue compares cadence against a provided clock", () => {
  const now = Date.UTC(2026, 4, 4, 12);

  assert.equal(isOverdue("daily", new Date(now - 24 * 60 * 60 * 1000).toISOString(), now), true);
  assert.equal(isOverdue("daily", new Date(now - 23 * 60 * 60 * 1000).toISOString(), now), false);
  assert.equal(isOverdue("weekly", new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(), now), true);
});

test("shortPathLabel keeps badges compact", () => {
  assert.equal(shortPathLabel(""), ":memory:");
  assert.equal(shortPathLabel(":memory:"), ":memory:");
  assert.equal(shortPathLabel("/Users/me/data.duckdb"), "data.duckdb");
  assert.equal(shortPathLabel("C:\\Users\\me\\data.duckdb"), "data.duckdb");
  assert.equal(shortPathLabel("opfs://notes.duckdb"), "notes.duckdb");
});
