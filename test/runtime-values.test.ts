import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  vectorFromArray,
  DateDay,
  Field,
  List,
  Struct,
  TimeMicrosecond,
  TimeMillisecond,
  TimestampMicrosecond,
} from "apache-arrow";
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

// Issue #18: Arrow JS (>=14, bundled by DuckDB-Wasm) returns DATE columns as
// epoch-millisecond numbers, which the plugin rendered verbatim as Unix
// timestamps. With the column's Arrow type, normalizeValue formats them.
test("normalizeValue formats Arrow DATE columns as YYYY-MM-DD", () => {
  const vec = vectorFromArray([new Date(Date.UTC(2026, 5, 1))], new DateDay());
  const raw = vec.get(0);
  // The exact symptom from the issue: a 13-digit epoch-ms number.
  assert.equal(raw, 1780272000000);
  assert.equal(normalizeValue(raw, vec.type), "2026-06-01");
});

test("normalizeValue formats Arrow TIMESTAMP columns as readable timestamps", () => {
  const ts = vectorFromArray(
    [new Date("2026-06-01T12:34:56.789Z")],
    new TimestampMicrosecond(),
  );
  assert.equal(typeof ts.get(0), "number");
  assert.equal(normalizeValue(ts.get(0), ts.type), "2026-06-01 12:34:56.789");

  // Whole-second values drop the ".000".
  const whole = vectorFromArray(
    [new Date("2026-06-01T12:34:56Z")],
    new TimestampMicrosecond(),
  );
  assert.equal(normalizeValue(whole.get(0), whole.type), "2026-06-01 12:34:56");

  // TIMESTAMPTZ: Arrow normalizes to UTC; render with an explicit offset.
  assert.equal(
    normalizeValue(ts.get(0), new TimestampMicrosecond("UTC")),
    "2026-06-01 12:34:56.789+00",
  );
});

test("normalizeValue formats Arrow TIME columns as HH:MM:SS", () => {
  // DuckDB TIME is microsecond-unit; Arrow JS hands it over as bigint micros.
  const micros = new TimeMicrosecond();
  assert.equal(normalizeValue(45_296_000_000n, micros), "12:34:56");
  assert.equal(normalizeValue(45_296_789_000n, micros), "12:34:56.789");
  assert.equal(normalizeValue(0n, micros), "00:00:00");
  // Millisecond-unit times arrive as plain numbers.
  assert.equal(normalizeValue(45_296_789, new TimeMillisecond()), "12:34:56.789");
});

test("normalizeValue formats dates nested in LIST and STRUCT columns", () => {
  const list = vectorFromArray(
    [[new Date(Date.UTC(2026, 5, 1))]],
    new List(new Field("item", new DateDay())),
  );
  assert.deepEqual(normalizeValue(list.get(0), list.type), ["2026-06-01"]);

  const struct = vectorFromArray(
    [{ d: new Date(Date.UTC(2026, 5, 1)) }],
    new Struct([new Field("d", new DateDay())]),
  );
  assert.deepEqual(normalizeValue(struct.get(0), struct.type), {
    d: "2026-06-01",
  });
});

test("normalizeValue without a column type keeps legacy behavior", () => {
  // Plain numeric columns (no Arrow type passed) must not be reinterpreted.
  assert.equal(normalizeValue(1780272000000), 1780272000000);
});
