export type Row = Record<string, unknown>;

export interface QueryResult {
  rows: Row[];
  columns: string[];
}

export interface Runtime {
  init(): Promise<void>;
  runQuery(sql: string): Promise<QueryResult>;
  close(): Promise<void>;
  label(): string;
}

// DuckDB and MotherDuck both return values that can be awkward to render or
// serialize directly: bigint, Arrow vectors, and custom MotherDuck value
// objects. Normalize at the runtime boundary so the UI and frozen markdown only
// deal with plain display values.
export function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  if (Array.isArray(v)) return v.map((item) => normalizeValue(item));
  if (typeof v === "object") {
    const maybeStringifiable = v as { toString?: () => string };
    if (
      typeof maybeStringifiable.toString === "function" &&
      maybeStringifiable.toString !== Object.prototype.toString
    ) {
      return maybeStringifiable.toString();
    }
    const out: Row = {};
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
      out[key] = normalizeValue(value);
    }
    return out;
  }
  return v;
}
