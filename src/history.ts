import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

export function formatHistoryEntry(entry: HistoryEntry): string {
  const status = entry.success ? "ok" : "FAIL";
  const error = entry.error ? ` (${entry.error})` : "";
  return `  ${entry.timestamp}  ${entry.handle}: ${status} ${entry.durationMs}ms${error}`;
}

export function readHistory(limit?: number): HistoryEntry[] {
  const file = historyFile();
  if (!existsSync(file)) return [];
  const content = readFileSync(file, "utf-8").trim();
  if (!content) return [];
  const entries = content
    .split("\n")
    .map((line) => JSON.parse(line) as HistoryEntry);
  if (limit !== undefined && limit < entries.length) {
    return entries.slice(-limit);
  }
  return entries;
}
