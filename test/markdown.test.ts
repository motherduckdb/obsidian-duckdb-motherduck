import { strict as assert } from "node:assert";
import { test } from "node:test";
import { findBlocks, writeSentinelAfterBlock } from "../src/markdown";

test("findBlocks parses duckdb and motherduck fences with info text", () => {
  const blocks = findBlocks(
    [
      "# Dashboard",
      "```duckdb title=\"local\"",
      "select 1 as x",
      "```",
      "text",
      "~~~~motherduck",
      "select 2 as y",
      "~~~~",
    ].join("\n"),
  );

  assert.deepEqual(blocks, [
    { connection: "local", sql: "select 1 as x", startLine: 1, endLine: 3 },
    { connection: "cloud", sql: "select 2 as y", startLine: 5, endLine: 7 },
  ]);
});

test("findBlocks respects longer fences around inner backticks", () => {
  const blocks = findBlocks(
    [
      "````duckdb",
      "select '```' as fence_text",
      "```",
      "select 2",
      "````",
    ].join("\n"),
  );

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].sql, "select '```' as fence_text\n```\nselect 2");
  assert.equal(blocks[0].endLine, 4);
});

test("writeSentinelAfterBlock inserts a frozen result after a block", () => {
  const content = ["before", "```duckdb", "select 1", "```", "after"].join("\n");
  const block = findBlocks(content)[0];

  assert.equal(
    writeSentinelAfterBlock(content, block, "<!-- md:cache hash=x -->\n\nresult\n\n<!-- md:cache-end -->"),
    [
      "before",
      "```duckdb",
      "select 1",
      "```",
      "",
      "<!-- md:cache hash=x -->",
      "",
      "result",
      "",
      "<!-- md:cache-end -->",
      "",
      "after",
    ].join("\n"),
  );
});

test("writeSentinelAfterBlock replaces an existing frozen result", () => {
  const content = [
    "```duckdb",
    "select 1",
    "```",
    "",
    "<!-- md:cache hash=old -->",
    "",
    "old",
    "",
    "<!-- md:cache-end -->",
    "",
    "after",
  ].join("\n");
  const block = findBlocks(content)[0];

  const updated = writeSentinelAfterBlock(
    content,
    block,
    "<!-- md:cache hash=new -->\n\nnew\n\n<!-- md:cache-end -->",
  );

  assert.match(updated, /hash=new/);
  assert.doesNotMatch(updated, /hash=old|old/);
  assert.match(updated, /\nafter$/);
});
