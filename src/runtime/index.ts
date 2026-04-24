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
