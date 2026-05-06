import type { Row } from "./runtime";
import type { Connection } from "./types";
import { DEFAULTS } from "./types";

export function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function stringifyCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

export function truncateString(s: string, charCap: number): string {
  const cap = normalizedCellCharCap(charCap);
  if (s.length <= cap) return s;
  return s.slice(0, Math.max(1, cap - 1)) + "…";
}

export function escapeCell(v: unknown, charCap: number = DEFAULTS.cellCharCap): string {
  const s = truncateString(stringifyCell(v), charCap);
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ").replace(/\r/g, "");
}

export function renderMarkdownTable(
  rows: Row[],
  columns: string[],
  sql: string,
  connection: Connection,
  rowCap: number,
  cellCharCap: number = DEFAULTS.cellCharCap,
): string {
  const hash = simpleHash(`${connection}\n${sql.trim()}`);
  const ts = new Date().toISOString();
  const totalRows = rows.length;
  const cap = normalizedRowCap(rowCap);
  const shown = rows.slice(0, cap);

  const open = `<!-- md:cache hash=${hash} conn=${connection} ts=${ts} rows=${totalRows} -->`;
  const close = "<!-- md:cache-end -->";

  if (columns.length === 0) {
    return `${open}\n\n_(0 rows)_\n\n${close}`;
  }

  const header = "| " + columns.map((c) => escapeCell(c, cellCharCap)).join(" | ") + " |";
  const sep = "| " + columns.map(() => "---").join(" | ") + " |";
  const body = shown.map(
    (r) => "| " + columns.map((c) => escapeCell(r[c], cellCharCap)).join(" | ") + " |",
  );
  const emptyNotice = totalRows === 0 ? "\n\n> 0 rows" : "";
  const truncated =
    totalRows > cap ? `\n\n> … ${totalRows - cap} more rows hidden (cap ${cap})` : "";

  return `${open}\n\n${header}\n${sep}\n${body.join("\n")}${emptyNotice}${truncated}\n\n${close}`;
}

export function renderDomTable(
  parent: HTMLElement & { createEl: (tag: string, options?: Record<string, unknown>) => HTMLElement },
  rows: Row[],
  columns: string[],
  rowCap: number,
  cellCharCap: number = DEFAULTS.cellCharCap,
) {
  if (columns.length === 0) {
    parent.createEl("em", { text: "(0 rows)" });
    return;
  }

  const cap = normalizedRowCap(rowCap);
  const shown = rows.slice(0, cap);
  const table = parent.createEl("table", { cls: "motherduck-result-table" });
  const thead = table.createEl("thead").createEl("tr");

  for (const c of columns) {
    thead.createEl("th", { text: c });
  }

  const tbody = table.createEl("tbody");
  for (const row of shown) {
    const tr = tbody.createEl("tr");
    for (const c of columns) {
      const td = tr.createEl("td");
      const full = stringifyCell(row[c]);
      const display = truncateString(full, cellCharCap);
      td.setText(display);
      if (display !== full) {
        td.title = full;
      }
    }
  }

  if (rows.length === 0) {
    const empty = parent.createEl("div", { cls: "motherduck-muted", text: "0 rows" });
    empty.style.marginTop = "4px";
  }

  if (rows.length > cap) {
    const more = parent.createEl("div", {
      cls: "motherduck-muted",
      text: `… ${rows.length - cap} more rows hidden (cap ${cap})`,
    });
    more.style.marginTop = "4px";
  }
}

export function normalizedRowCap(rowCap: number): number {
  return Number.isFinite(rowCap) && rowCap > 0
    ? Math.min(Math.floor(rowCap), 10000)
    : DEFAULTS.rowCap;
}

export function normalizedCellCharCap(charCap: number): number {
  return Number.isFinite(charCap) && charCap > 0
    ? Math.min(Math.floor(charCap), 10000)
    : DEFAULTS.cellCharCap;
}
