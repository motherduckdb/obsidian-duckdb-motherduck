import { CADENCE_MS, type Cadence } from "./types";

export function isOverdue(cadence: Cadence, lastRefresh: string | null, now = Date.now()): boolean {
  if (!lastRefresh) return true;
  const last = Date.parse(lastRefresh);
  if (Number.isNaN(last)) return true;
  return now - last >= CADENCE_MS[cadence];
}

export function formatLogTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
