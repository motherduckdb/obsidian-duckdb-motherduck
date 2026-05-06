import { CADENCE_MS, type Cadence, type RefreshLogEntry } from "./types";

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

/**
 * "All-error failure" = the refresh attempt produced zero successful blocks
 * AND signaled an error. Either every block in the note errored, or the file
 * couldn't be processed at all (caught at the outer try/catch).
 *
 * Partial-failure entries (some blocks refreshed, some errored) are NOT
 * counted — we don't want to auto-unschedule a note where one block is
 * working fine just because a sibling block is broken.
 */
export function isAllErrorFailure(entry: RefreshLogEntry): boolean {
  return entry.blocks === 0 && (entry.errored > 0 || !!entry.errorMessage);
}

/**
 * Counts consecutive all-error log entries for `path` from newest backward,
 * stopping as soon as a success (or partial success) is encountered. Log is
 * expected newest-first (we unshift on append).
 */
export function consecutiveAllErrorFailures(
  log: ReadonlyArray<RefreshLogEntry>,
  path: string,
): number {
  let count = 0;
  for (const entry of log) {
    if (entry.path !== path) continue;
    if (!isAllErrorFailure(entry)) return count;
    count++;
  }
  return count;
}
