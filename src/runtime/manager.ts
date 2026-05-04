import { DuckDBWasmRuntime } from "./duckdb";
import { MotherDuckRuntime } from "./motherduck";
import type { Row, Runtime } from ".";
import type { Connection, QueryRunResult, Settings } from "../types";

export class RuntimeManager {
  private localRuntime: Runtime | null = null;
  private cloudRuntime: Runtime | null = null;
  private localRuntimePromise: Promise<Runtime> | null = null;
  private cloudRuntimePromise: Promise<Runtime> | null = null;
  private generation: Record<Connection, number> = {
    local: 0,
    cloud: 0,
  };
  private queryQueues: Record<Connection, Promise<unknown>> = {
    local: Promise.resolve(),
    cloud: Promise.resolve(),
  };

  constructor(private getSettings: () => Settings) {}

  async reset(only?: Connection) {
    if (!only || only === "local") {
      this.generation.local++;
      this.localRuntimePromise = null;
      this.queryQueues.local = Promise.resolve();
      try {
        await this.localRuntime?.close();
      } catch (e) {
        console.error("[motherduck] close local failed", e);
      }
      this.localRuntime = null;
    }

    if (!only || only === "cloud") {
      this.generation.cloud++;
      this.cloudRuntimePromise = null;
      this.queryQueues.cloud = Promise.resolve();
      try {
        await this.cloudRuntime?.close();
      } catch (e) {
        console.error("[motherduck] close cloud failed", e);
      }
      this.cloudRuntime = null;
    }
  }

  async runQuery(sql: string, connection: Connection): Promise<QueryRunResult> {
    return this.enqueueQuery(connection, async () => {
      const rt = await this.getRuntime(connection);
      return rt.runQuery(sql);
    });
  }

  private async getRuntime(connection: Connection): Promise<Runtime> {
    const settings = this.getSettings();

    if (connection === "cloud") {
      if (!settings.mdToken) {
        throw new Error("MotherDuck token not set. Configure it in plugin settings.");
      }
      if (this.cloudRuntime) return this.cloudRuntime;
      if (!this.cloudRuntimePromise) {
        const rt = new MotherDuckRuntime(settings.mdToken);
        const generation = this.generation.cloud;
        this.cloudRuntimePromise = this.initRuntime(rt, "cloud", generation);
      }
      return this.cloudRuntimePromise;
    }

    if (this.localRuntime) return this.localRuntime;
    if (!this.localRuntimePromise) {
      const rt = new DuckDBWasmRuntime(settings.dbPath);
      const generation = this.generation.local;
      this.localRuntimePromise = this.initRuntime(rt, "local", generation);
    }
    return this.localRuntimePromise;
  }

  private initRuntime(rt: Runtime, connection: Connection, generation: number): Promise<Runtime> {
    return rt
      .init()
      .then(() => {
        if (this.generation[connection] !== generation) {
          void rt.close();
          throw new Error(`${connectionLabel(connection)} connection reset while initializing. Retry the query.`);
        }
        if (connection === "cloud") this.cloudRuntime = rt;
        else this.localRuntime = rt;
        return rt;
      })
      .catch(async (e) => {
        await rt.close().catch((closeError) => {
          console.error(`[motherduck] close failed after ${connection} init error`, closeError);
        });
        throw e;
      })
      .finally(() => {
        if (connection === "cloud") this.cloudRuntimePromise = null;
        else this.localRuntimePromise = null;
      });
  }

  private enqueueQuery<T extends QueryRunResult | { rows: Row[]; columns: string[] }>(
    connection: Connection,
    op: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queryQueues[connection].catch(() => undefined);
    const next = previous.then(op);
    this.queryQueues[connection] = next.catch(() => undefined);
    return next;
  }
}

function connectionLabel(connection: Connection): string {
  return connection === "cloud" ? "MotherDuck" : "DuckDB";
}
