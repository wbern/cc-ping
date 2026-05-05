// Reads Claude Code's account history.jsonl (numeric ms timestamps).
// Not the same file as cc-ping's own history.jsonl in history.ts (ISO strings).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const QUOTA_WINDOW_HOURS = 5;
const QUOTA_WINDOW_MS = QUOTA_WINDOW_HOURS * 60 * 60 * 1000;

export function isRecentlyActive(historyLines: string[], now: Date): boolean {
  let latest = 0;
  for (const line of historyLines) {
    try {
      const entry = JSON.parse(line);
      if (typeof entry.timestamp === "number" && entry.timestamp > latest) {
        latest = entry.timestamp;
      }
    } catch {
      // skip malformed lines
    }
  }
  if (latest === 0) return false;
  return now.getTime() - latest < QUOTA_WINDOW_MS;
}

export function buildHourHistogram(timestamps: Date[]): number[] {
  const bins = new Array(24).fill(0);
  for (const ts of timestamps) {
    bins[ts.getUTCHours()]++;
  }
  return bins;
}

export function findOptimalPingHour(histogram: number[]): number {
  const total = histogram.reduce((sum, v) => sum + v, 0);
  if (total === 0) return -1;

  // Slide a 5-hour window across the 24-hour histogram to find the
  // start hour whose window captures the most activity
  let bestStart = 0;
  let bestSum = 0;
  for (let h = 0; h < 24; h++) {
    let windowSum = 0;
    for (let offset = 0; offset < QUOTA_WINDOW_HOURS; offset++) {
      windowSum += histogram[(h + offset) % 24];
    }
    if (windowSum > bestSum) {
      bestSum = windowSum;
      bestStart = h;
    }
  }

  // Return the hour to ping such that the window expires at the midpoint
  // of the densest period. The next ping then covers the peak, and the
  // defer zone falls in pre-activity hours rather than overlapping with
  // the start of the user's workday.
  const midpoint = (bestStart + Math.floor(QUOTA_WINDOW_HOURS / 2)) % 24;
  return (midpoint - QUOTA_WINDOW_HOURS + 24) % 24;
}

export interface DeferResult {
  defer: boolean;
  deferUntilUtcHour?: number;
}

export function shouldDefer(now: Date, optimalPingHour: number): DeferResult {
  const currentHour = now.getUTCHours();

  // Defer zone: the 5h window before the optimal ping time
  // If current time is in [optimal - 5, optimal), defer to optimal
  const zoneStart = (optimalPingHour - QUOTA_WINDOW_HOURS + 24) % 24;
  const inZone =
    zoneStart < optimalPingHour
      ? currentHour >= zoneStart && currentHour < optimalPingHour
      : currentHour >= zoneStart || currentHour < optimalPingHour;

  if (inZone) {
    return { defer: true, deferUntilUtcHour: optimalPingHour };
  }
  return { defer: false };
}

const MIN_DAYS = 7;
const HISTORY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

interface AccountSchedule {
  optimalPingHour: number;
  peakStart: number;
  peakEnd: number;
  histogram: number[];
}

export function getAccountSchedule(
  historyLines: string[],
  now: Date = new Date(),
  resetAt?: Date,
): AccountSchedule | null {
  const cutoff = Math.max(
    now.getTime() - HISTORY_WINDOW_MS,
    resetAt?.getTime() ?? 0,
  );
  const timestamps: Date[] = [];
  const daysSeen = new Set<string>();

  for (const line of historyLines) {
    try {
      const entry = JSON.parse(line);
      if (typeof entry.timestamp !== "number") continue;
      if (entry.timestamp < cutoff) continue;
      const date = new Date(entry.timestamp);
      timestamps.push(date);
      daysSeen.add(date.toISOString().slice(0, 10));
    } catch {
      // skip malformed lines
    }
  }

  if (daysSeen.size < MIN_DAYS) return null;

  const histogram = buildHourHistogram(timestamps);

  // Flat histogram check: if max bin is ≤ 1.5× average, no clear pattern
  const total = histogram.reduce((sum, v) => sum + v, 0);
  const avg = total / 24;
  const max = Math.max(...histogram);
  if (max <= avg * 1.5) return null;

  const optimalPingHour = findOptimalPingHour(histogram);
  /* c8 ignore next -- defensive: flat histogram already caught above */
  if (optimalPingHour === -1) return null;

  const peakStart =
    (optimalPingHour + Math.floor(QUOTA_WINDOW_HOURS / 2) + 1) % 24;
  const peakEnd = (peakStart + QUOTA_WINDOW_HOURS) % 24;

  return { optimalPingHour, peakStart, peakEnd, histogram };
}

function readHistoryLines(configDir: string): string[] | null {
  const historyPath = join(configDir, "history.jsonl");
  if (!existsSync(historyPath)) return null;
  const content = readFileSync(historyPath, "utf-8");
  return content.split("\n").filter((l) => l.trim());
}

export function readAccountSchedule(
  configDir: string,
  now: Date = new Date(),
  resetAt?: Date,
): AccountSchedule | null {
  const lines = readHistoryLines(configDir);
  if (!lines) return null;
  return getAccountSchedule(lines, now, resetAt);
}

export function checkRecentActivity(
  configDir: string,
  now: Date = new Date(),
): boolean {
  const lines = readHistoryLines(configDir);
  if (!lines) return false;
  return isRecentlyActive(lines, now);
}

const TRUTHY = new Set(["true", "on", "1"]);
const FALSY = new Set(["false", "off", "0"]);

export function parseSmartSchedule(value: string): boolean {
  const lower = value.toLowerCase();
  if (TRUTHY.has(lower)) return true;
  if (FALSY.has(lower)) return false;
  throw new Error(
    `Invalid smart-schedule value: "${value}". Use true/false, on/off, or 1/0`,
  );
}
