import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  candidateVaultPaths,
  extractFileLiterals,
  isVaultCandidate,
  normalizeVaultPath,
} from "../src/local-files";

test("extractFileLiterals pulls paths from reader functions", () => {
  assert.deepEqual(
    extractFileLiterals("SELECT * FROM read_csv('data/sales.csv')"),
    ["data/sales.csv"],
  );
  assert.deepEqual(
    extractFileLiterals("SELECT * FROM read_parquet('events.parquet') WHERE x > 1"),
    ["events.parquet"],
  );
  // read_json / read_ndjson / *_auto variants, case-insensitive
  assert.deepEqual(
    extractFileLiterals("select * from READ_JSON_AUTO( 'a.json' )"),
    ["a.json"],
  );
});

test("extractFileLiterals handles bare FROM 'file'", () => {
  assert.deepEqual(
    extractFileLiterals("FROM 'reports/q1.parquet'"),
    ["reports/q1.parquet"],
  );
});

test("extractFileLiterals dedupes and preserves first-seen order", () => {
  const sql = `
    SELECT * FROM read_csv('a.csv') a
    JOIN read_parquet('b.parquet') b USING (id)
    WHERE a.x IN (SELECT x FROM read_csv('a.csv'))
  `;
  assert.deepEqual(extractFileLiterals(sql), ["a.csv", "b.parquet"]);
});

test("extractFileLiterals ignores non-file string literals", () => {
  // A quoted value in a WHERE clause is not a reader argument.
  assert.deepEqual(
    extractFileLiterals("SELECT * FROM t WHERE name = 'cities.csv'"),
    [],
  );
});

test("extractFileLiterals ignores comments and quoted examples", () => {
  const sql = `
    -- read_csv('line-comment.csv')
    /* read_parquet('block-comment.parquet') */
    SELECT $$read_json('dollar-quoted.json')$$ AS example,
           'read_csv(''ordinary-string.csv'')' AS another
    FROM read_csv/* an inline comment */('real.csv')
  `;
  assert.deepEqual(extractFileLiterals(sql), ["real.csv"]);
});

test("extractFileLiterals decodes escaped apostrophes in paths", () => {
  assert.deepEqual(
    extractFileLiterals("SELECT * FROM read_csv('data/O''Brien.csv')"),
    ["data/O'Brien.csv"],
  );
});

test("extractFileLiterals preserves SQL order across reader and bare FROM forms", () => {
  assert.deepEqual(
    extractFileLiterals("FROM 'first.parquet' UNION ALL FROM read_csv('second.csv')"),
    ["first.parquet", "second.csv"],
  );
});

test("isVaultCandidate accepts vault-relative data paths", () => {
  assert.equal(isVaultCandidate("data/sales.csv"), true);
  assert.equal(isVaultCandidate("sales.csv"), true);
  assert.equal(isVaultCandidate("./sales.csv"), true);
});

test("isVaultCandidate rejects URLs, absolute paths, and globs", () => {
  assert.equal(isVaultCandidate("https://example.com/x.csv"), false);
  assert.equal(isVaultCandidate("s3://bucket/x.parquet"), false);
  assert.equal(isVaultCandidate("opfs://x.csv"), false);
  assert.equal(isVaultCandidate("/Users/me/x.csv"), false);
  assert.equal(isVaultCandidate("C:\\data\\x.csv"), false);
  assert.equal(isVaultCandidate("C:/data/x.csv"), false);
  assert.equal(isVaultCandidate("data/*.parquet"), false);
  assert.equal(isVaultCandidate("data/file?.csv"), false);
  assert.equal(isVaultCandidate(""), false);
});

test("normalizeVaultPath resolves . and .. segments", () => {
  assert.equal(normalizeVaultPath("a/./b/c"), "a/b/c");
  assert.equal(normalizeVaultPath("a/b/../c"), "a/c");
  assert.equal(normalizeVaultPath("notes/../data/x.csv"), "data/x.csv");
});

test("candidateVaultPaths tries note folder first, then vault root", () => {
  assert.deepEqual(
    candidateVaultPaths("sales.csv", "finance/2026/report.md"),
    ["finance/2026/sales.csv", "sales.csv"],
  );
});

test("candidateVaultPaths resolves relative subfolders against the note", () => {
  assert.deepEqual(
    candidateVaultPaths("data/sales.csv", "finance/report.md"),
    ["finance/data/sales.csv", "data/sales.csv"],
  );
});

test("candidateVaultPaths handles a note at the vault root", () => {
  // No folder prefix -> single vault-root candidate.
  assert.deepEqual(candidateVaultPaths("sales.csv", "report.md"), ["sales.csv"]);
});

test("candidateVaultPaths falls back to vault root with no note path", () => {
  assert.deepEqual(candidateVaultPaths("data/sales.csv"), ["data/sales.csv"]);
});

test("candidateVaultPaths strips a leading ./", () => {
  assert.deepEqual(
    candidateVaultPaths("./sales.csv", "finance/report.md"),
    ["finance/sales.csv", "sales.csv"],
  );
});
