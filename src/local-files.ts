// Pull local-file references out of a SQL query so the plugin can read those
// files from the vault and hand their bytes to DuckDB-Wasm (which otherwise
// has no path into the host filesystem). Pure string logic only — the actual
// vault read / size gate / buffer registration lives in main.ts, where the
// Obsidian app and runtime are in scope. Kept separate so it's unit-testable
// without an Obsidian or WASM environment.

// File-reading table functions DuckDB exposes. We only look at the first
// single-quoted argument; list forms (`read_csv(['a.csv','b.csv'])`) and globs
// are intentionally out of scope for v1 (see isVaultCandidate).
const READER_FNS = new Set([
  "read_csv",
  "read_csv_auto",
  "read_parquet",
  "read_json",
  "read_json_auto",
  "read_ndjson",
  "read_ndjson_auto",
]);

type SqlToken =
  | { kind: "word"; value: string }
  | { kind: "string"; value: string }
  | { kind: "punct"; value: string };

function isWordStart(c: string): boolean {
  return /[A-Za-z_]/.test(c);
}

function isWordPart(c: string): boolean {
  return /[A-Za-z0-9_$]/.test(c);
}

// Tokenize only the SQL shapes needed for file extraction. Comments, quoted
// identifiers, and dollar-quoted strings are skipped so text that merely
// mentions `read_csv('x.csv')` cannot trigger a vault read. SQL strings are
// decoded (`'O''Brien.csv'` -> `O'Brien.csv`) because DuckDB resolves the
// decoded filename, not the source spelling.
function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;

  while (i < sql.length) {
    const c = sql[i];

    if (/\s/.test(c)) {
      i++;
      continue;
    }

    if (c === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }

    if (c === "/" && sql[i + 1] === "*") {
      i += 2;
      let depth = 1;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      continue;
    }

    if (c === "'") {
      let value = "";
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          value += "'";
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          value += sql[i];
          i++;
        }
      }
      tokens.push({ kind: "string", value });
      continue;
    }

    if (c === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i] === '"') {
          i++;
          break;
        } else i++;
      }
      continue;
    }

    if (c === "$") {
      const opener = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (opener) {
        const close = sql.indexOf(opener, i + opener.length);
        i = close === -1 ? sql.length : close + opener.length;
        continue;
      }
    }

    if (isWordStart(c)) {
      const start = i++;
      while (i < sql.length && isWordPart(sql[i])) i++;
      tokens.push({ kind: "word", value: sql.slice(start, i).toLowerCase() });
      continue;
    }

    tokens.push({ kind: "punct", value: c });
    i++;
  }

  return tokens;
}

// Extract decoded file path literals from a query, de-duplicated in first-seen
// order. Registering bytes under the decoded name matches the filename DuckDB
// resolves from the SQL string.
export function extractFileLiterals(sql: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const tokens = tokenizeSql(sql);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    let literal: string | undefined;
    if (
      token.kind === "word" &&
      READER_FNS.has(token.value) &&
      tokens[i + 1]?.kind === "punct" &&
      tokens[i + 1].value === "(" &&
      tokens[i + 2]?.kind === "string"
    ) {
      literal = tokens[i + 2].value;
    } else if (
      token.kind === "word" &&
      token.value === "from" &&
      tokens[i + 1]?.kind === "string"
    ) {
      literal = tokens[i + 1].value;
    }

    if (literal !== undefined && !seen.has(literal)) {
      seen.add(literal);
      out.push(literal);
    }
  }
  return out;
}

// Is this literal something we should try to read from the vault? We register
// only vault-relative data files. Everything else is left for DuckDB to resolve
// itself:
//   - `scheme://...`  remote/OPFS URLs go through httpfs, no local copy needed.
//   - absolute paths  (`/x`, `C:\x`) point outside the vault and aren't exposed
//                     to DuckDB-Wasm by this bridge.
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
