import { MDConnection } from "@motherduck/wasm-client";
import { Row, QueryResult, Runtime, normalizeValue } from "./index";

export class MotherDuckRuntime implements Runtime {
  private connection: MDConnection | null = null;

  constructor(private token: string) {}

  label() {
    return "MotherDuck (cloud)";
  }

  async init(): Promise<void> {
    if (this.connection) return;
    if (!this.token) throw new Error("MotherDuck token required");
    this.connection = MDConnection.create({
      mdToken: this.token,
      useDuckDBWasmCOI: false,
    });
    await this.connection.isInitialized();
  }

  async runQuery(sql: string, rowCap?: number): Promise<QueryResult> {
    if (!this.connection) await this.init();

    if (rowCap === undefined) {
      const result = await this.connection!.safeEvaluateQuery(sql);
      if (result.status !== "success") {
        const err = (result as { err?: { message?: string } }).err;
        throw new Error(err?.message ?? JSON.stringify(err));
      }
      const columns = [...result.result.data.deduplicatedColumnNames()];
      const rows = result.result.data.toRows().map((row) => {
        const out: Row = {};
        for (const column of columns) out[column] = normalizeValue(row[column]);
        return out;
      });
      return { rows, columns, truncated: false };
    }

    // Streaming path: dataReader.readUntil(N) reads in batches of ~2048 rows
    // until at least N rows are buffered. We ask for rowCap+1 to detect
    // truncation, then trim to rowCap.
    const result = await this.connection!.safeEvaluateStreamingQuery(sql);
    if (result.status !== "success") {
      const err = (result as { err?: { message?: string } }).err;
      throw new Error(err?.message ?? JSON.stringify(err));
    }
    const reader = result.result.dataReader;
    await reader.readUntil(rowCap + 1);

    const columns = [...reader.deduplicatedColumnNames()];
    const allRows = reader.toRows();
    const truncated = allRows.length > rowCap;
    const sliced = truncated ? allRows.slice(0, rowCap) : allRows;
    const rows = sliced.map((row) => {
      const out: Row = {};
      for (const column of columns) out[column] = normalizeValue(row[column]);
      return out;
    });
    return { rows, columns, truncated };
  }

  async close(): Promise<void> {
    try {
      await this.connection?.close();
    } finally {
      this.connection = null;
    }
  }
}
