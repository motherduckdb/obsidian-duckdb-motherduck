import { AsyncDuckDB, ConsoleLogger, selectBundle, DuckDBBundles } from "@duckdb/duckdb-wasm";
import workerEh from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js";
import workerMvp from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js";
import { Row, QueryResult, Runtime } from "./index";

// Pin to a known-good version; the .wasm binaries are fetched from jsDelivr at
// runtime (too large to bundle into main.js).
const DUCKDB_WASM_VERSION = "1.33.1-dev45.0";
const CDN_BASE = `https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@${DUCKDB_WASM_VERSION}/dist`;

// Electron's renderer workers expose `process` (Node integration). Libraries
// bundled into the DuckDB worker (e.g. js-sha256) detect `process` and take a
// Node path that then fails to resolve `Buffer`. Strip node globals before the
// worker source runs so browser code paths are used instead.
const WORKER_SHIM = `try{Object.defineProperty(globalThis,'process',{value:undefined,configurable:true,writable:true});}catch(e){}try{Object.defineProperty(globalThis,'Buffer',{value:undefined,configurable:true,writable:true});}catch(e){}`;

function workerBlob(src: string): string {
  return URL.createObjectURL(
    new Blob([WORKER_SHIM + src], { type: "text/javascript" }),
  );
}

export class DuckDBWasmRuntime implements Runtime {
  private db: AsyncDuckDB | null = null;
  private conn: Awaited<ReturnType<AsyncDuckDB["connect"]>> | null = null;
  private workerUrl: string | null = null;

  constructor(private dbPath: string = ":memory:") {}

  label() {
    return this.dbPath === ":memory:" ? "DuckDB WASM (memory)" : `DuckDB WASM (${this.dbPath})`;
  }

  async init(): Promise<void> {
    if (this.db && this.conn) return;

    const bundles: DuckDBBundles = {
      mvp: {
        mainModule: `${CDN_BASE}/duckdb-mvp.wasm`,
        mainWorker: workerBlob(workerMvp),
      },
      eh: {
        mainModule: `${CDN_BASE}/duckdb-eh.wasm`,
        mainWorker: workerBlob(workerEh),
      },
    };

    const bundle = await selectBundle(bundles);
    this.workerUrl = bundle.mainWorker!;
    const worker = new Worker(this.workerUrl);
    const logger = new ConsoleLogger();
    this.db = new AsyncDuckDB(logger, worker);
    await this.db.instantiate(bundle.mainModule);
    if (this.dbPath && this.dbPath !== ":memory:") {
      await this.db.open({ path: this.dbPath });
    }
    this.conn = await this.db.connect();
  }

  async runQuery(sql: string): Promise<QueryResult> {
    if (!this.conn) await this.init();
    const table = await this.conn!.query(sql);
    const columns = table.schema.fields.map((f) => f.name);
    const rows: Row[] = table.toArray().map((r: Record<string, unknown>) => {
      const obj: Row = {};
      for (const c of columns) obj[c] = normalize(r[c]);
      return obj;
    });
    return { rows, columns };
  }

  async close(): Promise<void> {
    try {
      await this.conn?.close();
      await this.db?.terminate();
    } finally {
      if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
      this.conn = null;
      this.db = null;
      this.workerUrl = null;
    }
  }
}

// Arrow types don't JSON-serialize cleanly. Coerce BigInt, Date, and TypedArrays
// to plain values so renderers and the sentinel hash stay stable.
function normalize(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  return v;
}
