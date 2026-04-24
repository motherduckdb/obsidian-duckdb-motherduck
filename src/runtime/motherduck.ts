import { MDConnection } from "@motherduck/wasm-client";
import { Row, QueryResult, Runtime } from "./index";

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

  async runQuery(sql: string): Promise<QueryResult> {
    if (!this.connection) await this.init();
    const result = await this.connection!.safeEvaluateQuery(sql);
    if (result.status !== "success") {
      const err = (result as { err?: { message?: string } }).err;
      throw new Error(err?.message ?? JSON.stringify(err));
    }
    const rows = result.result.data.toRows() as Row[];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    return { rows, columns };
  }

  async close(): Promise<void> {
    try {
      await this.connection?.close();
    } finally {
      this.connection = null;
    }
  }
}
