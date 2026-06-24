// Pull local-file references out of a SQL query so the plugin can read those
// files from the vault and hand their bytes to DuckDB-Wasm (which otherwise
// has no path into the host filesystem). Pure string logic only — the actual
// vault read / size gate / buffer registration lives in main.ts, where the
// Obsidian app and runtime are in scope. Kept separate so it's unit-testable
// without an Obsidian or WASM environment.

// File-reading table functions DuckDB exposes. We only look at the FIRST
// single-quoted argument; list forms (`read_csv(['a.csv','b.csv'])`) and globs
// are intentionally out of scope for v1 (see isVaultCandidate).
const READER_FNS = [
  "read_csv",
  "read_csv_auto",
  "read_parquet",
  "read_json",
  "read_json_auto",
  "read_ndjson",
  "read_ndjson_auto",
].join("|");

const READER_RE = new RegExp(`\\b(?:${READER_FNS})\\s*\\(\\s*'([^']+)'`, "gi");
// Bare `FROM 'file.parquet'` — DuckDB infers the reader from the extension.
const FROM_RE = /\bfrom\s+'([^']+)'/gi;

// Extract candidate file path literals from a query, de-duplicated in first-seen
// order. Returns the raw literal exactly as written so the caller can register
// the bytes under that same name and the SQL runs unchanged.
export function extractFileLiterals(sql: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const re of [READER_RE, FROM_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      const lit = m[1];
      if (!seen.has(lit)) {
        seen.add(lit);
        out.push(lit);
      }
    }
  }
  return out;
}

// Is this literal something we should try to read from the vault? We register
// only vault-relative data files. Everything else is left for DuckDB to resolve
// itself:
//   - `scheme://...`  remote/OPFS URLs go through httpfs, no local copy needed.
//   - absolute paths  (`/x`, `C:\x`) are real disk files, handled by the
//                     read-only DB-file path, not the vault bridge.
//   - globs           (`*`, `?`, `[`) expand inside the engine over its VFS;
//                     a single registered buffer can't satisfy them. Out of
//                     scope for v1; left to error clearly.
export function isVaultCandidate(literal: string): boolean {
  if (!literal) return false;
  if (literal.includes("://")) return false;
  if (literal.startsWith("/")) return false;
  if (/^[A-Za-z]:[\\/]/.test(literal)) return false;
  if (/[*?[\]]/.test(literal)) return false;
  return true;
}

function posixDirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "" : p.slice(0, i);
}

// Resolve `.`/`..` segments against a "/"-separated vault path. Vault paths are
// always forward-slash and root-relative, so this is deliberately simpler than
// Node's path (which we can't use on mobile anyway).
export function normalizeVaultPath(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

// Ordered vault paths to try for a literal: first relative to the note's own
// folder (so `data/x.csv` next to the note wins), then relative to the vault
// root. The caller picks the first that actually exists.
export function candidateVaultPaths(literal: string, notePath?: string): string[] {
  const lit = literal.replace(/^\.\//, "");
  const cands: string[] = [];
  const dir = notePath ? posixDirname(notePath) : "";
  if (dir) cands.push(normalizeVaultPath(`${dir}/${lit}`));
  cands.push(normalizeVaultPath(lit));
  return [...new Set(cands)].filter((c) => c.length > 0);
}
