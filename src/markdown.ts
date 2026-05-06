import type { Connection } from "./types";

export interface FencedBlock {
  sql: string;
  startLine: number;
  endLine: number;
  connection: Connection;
}

export function findBlocks(content: string): FencedBlock[] {
  const lines = content.split("\n");
  const blocks: FencedBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const open = lines[i].match(/^ {0,3}(`{3,}|~{3,})\s*(motherduck|duckdb)(?:\s+.*)?$/);
    if (!open) {
      i++;
      continue;
    }

    const fence = open[1];
    const fenceChar = fence[0];
    const closeRe = new RegExp(`^ {0,3}${escapeRegExp(fenceChar)}{${fence.length},}\\s*$`);
    const connection: Connection = open[2] === "duckdb" ? "local" : "cloud";
    const start = i;
    i++;

    const sqlLines: string[] = [];
    while (i < lines.length && !closeRe.test(lines[i])) {
      sqlLines.push(lines[i]);
      i++;
    }

    if (i < lines.length) {
      blocks.push({ sql: sqlLines.join("\n"), startLine: start, endLine: i, connection });
      i++;
    }
  }

  return blocks;
}

export function writeSentinelAfterBlock(
  content: string,
  block: FencedBlock,
  renderedResult: string,
): string {
  const lines = content.split("\n");
  const afterBlock = block.endLine + 1;
  let cutEnd = afterBlock;
  let j = afterBlock;

  while (j < lines.length && lines[j].trim() === "") j++;

  if (j < lines.length && /<!-- md:cache hash=/.test(lines[j])) {
    let k = j;
    while (k < lines.length && !/<!-- md:cache-end -->/.test(lines[k])) k++;
    if (k < lines.length) cutEnd = k + 1;
  }

  const before = lines.slice(0, afterBlock).join("\n");
  const rest = lines.slice(cutEnd).join("\n");
  return before + "\n\n" + renderedResult + (rest ? "\n\n" + rest : "\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findCacheHashAfterLine(content: string, lineEnd: number): string | null {
  const lines = content.split("\n");
  let j = lineEnd + 1;
  while (j < lines.length && lines[j].trim() === "") j++;
  if (j >= lines.length) return null;
  const m = lines[j].match(/<!-- md:cache hash=([0-9a-f]+)/);
  return m ? m[1] : null;
}
