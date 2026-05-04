import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizeValue } from "../src/runtime";

test("normalizeValue converts non-JSON primitives and nested values", () => {
  assert.equal(normalizeValue(42n), "42");
  assert.equal(normalizeValue(new Uint8Array([1, 2, 3])), "<3 bytes>");
  assert.deepEqual(normalizeValue([1n, null]), ["1", null]);
  assert.deepEqual(normalizeValue({ id: 1n, nested: { ok: true } }), {
    id: "1",
    nested: { ok: true },
  });
});

test("normalizeValue uses custom DuckDB value stringification", () => {
  const value = {
    micros: 123n,
    toString() {
      return "00:00:00.000123";
    },
  };

  assert.equal(normalizeValue(value), "00:00:00.000123");
});
