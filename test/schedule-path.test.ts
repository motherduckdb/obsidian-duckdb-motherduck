import { strict as assert } from "node:assert";
import { test } from "node:test";
import { shortPathLabel } from "../src/path";
import { consecutiveAllErrorFailures, isAllErrorFailure, isOverdue } from "../src/schedule";
import type { RefreshLogEntry } from "../src/types";

function entry(partial: Partial<RefreshLogEntry>): RefreshLogEntry {
  return {
    ts: "2026-05-06T00:00:00Z",
    path: "note.md",
    trigger: "schedule",
    blocks: 0,
    errored: 0,
    ...partial,
  };
}

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

test("isAllErrorFailure flags entries where every block failed or the file errored at the boundary", () => {
  // Caught at outer try/catch — file couldn't be processed at all
  assert.equal(isAllErrorFailure(entry({ blocks: 0, errored: 0, errorMessage: "vault read failed" })), true);
  // processAllBlocks: every block in the note errored
  assert.equal(isAllErrorFailure(entry({ blocks: 0, errored: 2, errorMessage: "boom" })), true);
  // Partial failure — one block worked, one errored — NOT counted
  assert.equal(isAllErrorFailure(entry({ blocks: 1, errored: 1, errorMessage: "boom" })), false);
  // Clean success
  assert.equal(isAllErrorFailure(entry({ blocks: 3, errored: 0 })), false);
});

test("consecutiveAllErrorFailures counts a streak from the head, ignoring other paths", () => {
  // newest-first ordering, like settings.refreshLog
  const log = [
    entry({ path: "note.md", blocks: 0, errored: 1, errorMessage: "x" }),
    entry({ path: "other.md", blocks: 1, errored: 0 }), // ignored
    entry({ path: "note.md", blocks: 0, errored: 1, errorMessage: "x" }),
    entry({ path: "note.md", blocks: 0, errored: 0, errorMessage: "x" }),
    entry({ path: "note.md", blocks: 1, errored: 0 }), // success: streak ends here
    entry({ path: "note.md", blocks: 0, errored: 1, errorMessage: "x" }),
  ];

  assert.equal(consecutiveAllErrorFailures(log, "note.md"), 3);
  assert.equal(consecutiveAllErrorFailures(log, "other.md"), 0);
  assert.equal(consecutiveAllErrorFailures(log, "missing.md"), 0);
});

test("consecutiveAllErrorFailures: partial failure breaks the streak", () => {
  const log = [
    entry({ path: "note.md", blocks: 0, errored: 1, errorMessage: "x" }),
    entry({ path: "note.md", blocks: 1, errored: 1, errorMessage: "x" }), // partial: streak ends
    entry({ path: "note.md", blocks: 0, errored: 1, errorMessage: "x" }),
  ];

  assert.equal(consecutiveAllErrorFailures(log, "note.md"), 1);
});

test("shortPathLabel keeps badges compact", () => {
  assert.equal(shortPathLabel(""), ":memory:");
  assert.equal(shortPathLabel(":memory:"), ":memory:");
  assert.equal(shortPathLabel("/Users/me/data.duckdb"), "data.duckdb");
  assert.equal(shortPathLabel("C:\\Users\\me\\data.duckdb"), "data.duckdb");
  assert.equal(shortPathLabel("opfs://notes.duckdb"), "notes.duckdb");
});
