export type Row = Record<string, unknown>;

export interface QueryResult {
  rows: Row[];
  columns: string[];
  /**
   * True when the query produced more rows than the caller asked for via
   * `rowCap`. The runtime stops reading at `rowCap + 1` and trims to `rowCap`,
   * so the precise total is unknown. False (or absent) means we materialized
   * the entire result and `rows.length` is the true total.
   */
  truncated: boolean;
}

export interface Runtime {
  init(): Promise<void>;
  /**
   * Run `sql` and return rows + columns. If `rowCap` is set, the runtime stops
   * reading after `rowCap + 1` rows, trims to `rowCap`, and returns
   * `truncated: true`. If `rowCap` is undefined, the entire result is
   * materialized (legacy behavior, used for the public plugin API).
   */
  runQuery(sql: string, rowCap?: number): Promise<QueryResult>;
  close(): Promise<void>;
  label(): string;
}

// Structural view of an Arrow DataType — just enough to detect and convert
// temporal columns. Structural (rather than apache-arrow's DataType class) so
// tests and callers can also pass plain objects.
export interface ArrowTypeLike {
  typeId: number;
  unit?: number;
  timezone?: string | null;
  children?: ReadonlyArray<{ name: string; type: ArrowTypeLike }> | null;
}

// Arrow `Type` / `TimeUnit` enum values (stable across apache-arrow majors).
// Local constants instead of importing apache-arrow so this module stays
// import-light for the MotherDuck runtime and tests.
const ARROW_TYPE = {
  Date: 8,
  Time: 9,
  Timestamp: 10,
  List: 12,
  Struct: 13,
} as const;
const ARROW_TIME_UNIT = {
  SECOND: 0,
  MILLISECOND: 1,
  MICROSECOND: 2,
  NANOSECOND: 3,
} as const;

function epochMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  return null;
}

// DATE has no time component; Arrow encodes it as UTC midnight, so the UTC
// date fields are exactly the stored date. 1780272000000 -> "2026-06-01".
function formatArrowDate(v: unknown): unknown {
  const ms = epochMs(v);
  if (ms === null) return v;
  return new Date(ms).toISOString().slice(0, 10);
}

// Match DuckDB's own rendering: "YYYY-MM-DD HH:MM:SS[.mmm]", plus "+00" for
// TIMESTAMPTZ (Arrow normalizes tz-aware values to UTC). Arrow hands us epoch
// milliseconds regardless of the column's unit, so sub-millisecond precision
// is already gone by the time the value reaches JS.
function formatArrowTimestamp(v: unknown, hasTimezone: boolean): unknown {
  const ms = epochMs(v);
  if (ms === null) return v;
  let s = new Date(ms).toISOString().replace("T", " ").slice(0, -1);
  if (s.endsWith(".000")) s = s.slice(0, -4);
  return hasTimezone ? `${s}+00` : s;
}

// TIME arrives as an integer in the column's unit (bigint for micro/nano,
// number for second/milli). Render as "HH:MM:SS[.ffffff]".
function formatArrowTime(v: unknown, unit?: number): unknown {
  let raw: bigint;
  if (typeof v === "bigint") raw = v;
  else if (typeof v === "number" && Number.isFinite(v)) raw = BigInt(Math.trunc(v));
  else return v;
  if (raw < 0n) return v;

  let micros: bigint;
  switch (unit) {
    case ARROW_TIME_UNIT.SECOND:
      micros = raw * 1_000_000n;
      break;
    case ARROW_TIME_UNIT.MILLISECOND:
      micros = raw * 1_000n;
      break;
    case ARROW_TIME_UNIT.NANOSECOND:
      micros = raw / 1_000n;
      break;
    default:
      // MICROSECOND — DuckDB's TIME unit.
      micros = raw;
  }

  const pad = (n: bigint) => String(n).padStart(2, "0");
  const hh = pad(micros / 3_600_000_000n);
  const mm = pad((micros / 60_000_000n) % 60n);
  const ss = pad((micros / 1_000_000n) % 60n);
  const frac = micros % 1_000_000n;
  const fracStr =
    frac > 0n ? `.${String(frac).padStart(6, "0").replace(/0+$/, "")}` : "";
  return `${hh}:${mm}:${ss}${fracStr}`;
}

// DuckDB and MotherDuck both return values that can be awkward to render or
// serialize directly: bigint, Arrow vectors, and custom MotherDuck value
// objects. Normalize at the runtime boundary so the UI and frozen markdown only
// deal with plain display values.
//
// Arrow JS (>=14, bundled by DuckDB-Wasm) returns temporal values as raw
// numbers — DATE and TIMESTAMP as epoch milliseconds, TIME as an integer in
// the column's unit — which are indistinguishable from numeric columns
// without the schema. Callers that have the Arrow schema pass the column
// `type` so those values can be formatted as dates/timestamps here.
export function normalizeValue(v: unknown, type?: ArrowTypeLike): unknown {
  if (v === null || v === undefined) return v;

  if (type) {
    switch (type.typeId) {
      case ARROW_TYPE.Date:
        return formatArrowDate(v);
      case ARROW_TYPE.Timestamp:
        return formatArrowTimestamp(v, Boolean(type.timezone));
      case ARROW_TYPE.Time:
        return formatArrowTime(v, type.unit);
      case ARROW_TYPE.List: {
        const child = type.children?.[0]?.type;
        const items = Array.isArray(v)
          ? v
          : typeof (v as { toArray?: unknown }).toArray === "function"
            ? (v as { toArray: () => Iterable<unknown> }).toArray()
            : null;
        if (items) {
          return Array.from(items, (item) => normalizeValue(item, child));
        }
        break;
      }
      case ARROW_TYPE.Struct: {
        if (typeof v === "object" && type.children?.length) {
          const out: Row = {};
          for (const { name, type: childType } of type.children) {
            out[name] = normalizeValue(
              (v as Record<string, unknown>)[name],
              childType,
            );
          }
          return out;
        }
        break;
      }
    }
  }

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
