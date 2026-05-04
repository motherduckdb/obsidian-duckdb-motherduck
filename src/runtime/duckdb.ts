import {
  AsyncDuckDB,
  ConsoleLogger,
  selectBundle,
  DuckDBBundles,
  DuckDBAccessMode,
} from "@duckdb/duckdb-wasm";
import workerEh from "@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js";
import workerMvp from "@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js";
import { Row, QueryResult, Runtime, normalizeValue } from "./index";

// Electron's renderer exposes Node's `require`. Used to read real disk files
// for read-only queries via DuckDB-Wasm's registerFileBuffer. Not available
// in browsers / mobile Obsidian, in which case file:// paths will surface a
// clear error to the user.
const NODE_REQUIRE: ((mod: string) => unknown) | null =
  typeof (globalThis as unknown as { require?: unknown }).require === "function"
    ? ((globalThis as unknown as { require: (m: string) => unknown }).require)
    : null;

// Pin to a known-good version; the .wasm binaries are fetched from jsDelivr at
// runtime (too large to bundle into main.js).
const DUCKDB_WASM_VERSION = "1.33.1-dev50.0";
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

  // Classify the user input into one of three runtime shapes. Tagged union
  // rather than a single string so the disk-path branch is a typed thing all
  // the way through, no string-prefix sniffing later.
  //   memory   - in-memory ephemeral
  //   uri      - any scheme DuckDB-Wasm understands directly (`opfs://`,
  //              `https://`, ...). Bare filenames are auto-prefixed `opfs://`
  //              for backwards compat; not advertised in the UI.
  //   disk     - native filesystem path on the host. Read-only ingest via
  //              Node's fs into a registered file buffer.
  private resolvedPath():
    | { kind: "memory" }
    | { kind: "uri"; uri: string }
    | { kind: "disk"; path: string } {
    const v = (this.dbPath || "").trim();
    if (!v || v === ":memory:") return { kind: "memory" };
    if (v.startsWith("file://")) return { kind: "disk", path: v };
    // Unix absolute (`/foo/bar`) or Windows drive-letter (`C:\…` or `C:/…`).
    if (v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v)) return { kind: "disk", path: v };
    if (v.includes("://")) return { kind: "uri", uri: v };
    return { kind: "uri", uri: `opfs://${v}` };
  }

  label() {
    const v = (this.dbPath || "").trim();
    return !v || v === ":memory:" ? "DuckDB WASM (memory)" : `DuckDB WASM (${v})`;
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

    const resolved = this.resolvedPath();
    if (resolved.kind === "uri") {
      await this.db.open({ path: resolved.uri });
    } else if (resolved.kind === "disk") {
      // Real disk file: read once via Electron's Node integration, register the
      // bytes as a virtual file inside the worker, open read-only. Writes from
      // SQL stay in the worker and are discarded on close, they don't make it
      // back to the on-disk file. Cross-platform handling via Node's `url`
      // and `path` rather than hand-rolling the file:// to native conversion
      // (which would mishandle `file:///C:/…` on Windows and `\` separators).
      if (!NODE_REQUIRE) {
        throw new Error(
          "Real filesystem paths require Node integration (Electron desktop). " +
            "Use `:memory:` or a bare filename instead.",
        );
      }
      const fs = NODE_REQUIRE("fs") as typeof import("fs");
      const url = NODE_REQUIRE("url") as typeof import("url");
      const path = NODE_REQUIRE("path") as typeof import("path");

      let realPath: string;
      if (resolved.path.startsWith("file://")) {
        try {
          realPath = url.fileURLToPath(resolved.path);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new Error(`Invalid file:// URL '${resolved.path}': ${msg}`);
        }
      } else {
        realPath = resolved.path;
      }

      let bytes: Uint8Array;
      try {
        const buf = await fs.promises.readFile(realPath);
        bytes = new Uint8Array(buf);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`Could not read DuckDB file at ${realPath}: ${msg}`);
      }
      const bufferName = path.basename(realPath) || "user.duckdb";
      await this.db.registerFileBuffer(bufferName, bytes);
      await this.db.open({ path: bufferName, accessMode: DuckDBAccessMode.READ_ONLY });
    }

    this.conn = await this.db.connect();
  }

  async runQuery(sql: string): Promise<QueryResult> {
    if (!this.conn) await this.init();
    const table = await this.conn!.query(sql);
    const columns = table.schema.fields.map((f) => f.name);
    const rows: Row[] = table.toArray().map((r: Record<string, unknown>) => {
      const obj: Row = {};
      for (const c of columns) obj[c] = normalizeValue(r[c]);
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
