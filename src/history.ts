// cc-ping's own ping history (ISO string timestamps). Not the same file as
// Claude Code's account history.jsonl read by schedule.ts (numeric ms).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { formatTimeAgo } from "./format.js";
import { resolveConfigDir } from "./paths.js";

interface HistoryEntry {
  timestamp: string;
  handle: string;
  success: boolean;
  durationMs: number;
  error?: string;
}

function historyFile(): string {
  return join(resolveConfigDir(), "history.jsonl");
}

export function appendHistoryEntry(entry: HistoryEntry): void {
  const dir = resolveConfigDir();
  mkdirSync(dir, { recursive: true });
  appendFileSync(historyFile(), `${JSON.stringify(entry)}\n`);
}

export function formatHistoryEntry(entry: HistoryEntry, now?: Date): string {
  const status = entry.success ? "ok" : "FAIL";
  const error = entry.error ? ` (${entry.error})` : "";
  const time = now ? formatTimeAgo(entry.timestamp, now) : entry.timestamp;
  return `  ${time}  ${entry.handle}: ${status} ${entry.durationMs}ms${error}`;
}

export function readHistory(limit?: number): HistoryEntry[] {
  const file = historyFile();
  if (!existsSync(file)) return [];
  const content = readFileSync(file, "utf-8").trim();
  if (!content) return [];
  const entries: HistoryEntry[] = [];
  for (const line of content.split("\n")) {
    try {
      entries.push(JSON.parse(line) as HistoryEntry);
    } catch {
      // skip malformed line (e.g. truncated by a partial write)
    }
  }
  if (limit !== undefined && limit < entries.length) {
    return entries.slice(-limit);
  }
  return entries;
}
