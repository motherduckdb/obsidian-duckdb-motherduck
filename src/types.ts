import type { Row } from "./runtime";

export type Connection = "local" | "cloud";
export type Cadence = "daily" | "weekly";

export const CADENCE_MS: Record<Cadence, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
export const STARTUP_DELAY_MS = 5 * 1000;
export const LOG_CAP = 100;

export interface RefreshLogEntry {
  ts: string;
  path: string;
  trigger: "schedule" | "manual";
  blocks: number;
  errored: number;
  errorMessage?: string;
}

export interface Settings {
  mdToken: string;
  dbPath: string;
  rowCap: number;
  cellCharCap: number;
  scheduleEnabled: boolean;
  resetAfterSchedule: boolean;
  refreshLog: RefreshLogEntry[];
}

export interface QueryRunResult {
  rows: Row[];
  columns: string[];
  truncated: boolean;
}

export interface SweepResult {
  refreshed: number;
  errored: number;
  checked: number;
}

export const DEFAULTS: Settings = {
  mdToken: "",
  dbPath: ":memory:",
  rowCap: 100,
  cellCharCap: 80,
  scheduleEnabled: false,
  resetAfterSchedule: true,
  refreshLog: [],
};

export const AUTO_DISABLE_FAILURE_THRESHOLD = 3;
