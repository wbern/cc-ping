import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PingMeta, PingState } from "./types.js";

const CONFIG_DIR = join(homedir(), ".config", "cc-ping");
const STATE_FILE = join(CONFIG_DIR, "state.json");

export const QUOTA_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours

export function loadState(): PingState {
  if (!existsSync(STATE_FILE)) {
    return { lastPing: {} };
  }
  const raw = readFileSync(STATE_FILE, "utf-8");
  return JSON.parse(raw) as PingState;
}

export function saveState(state: PingState): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

export function recordPing(
  handle: string,
  timestamp: Date = new Date(),
  meta?: PingMeta,
): void {
  const state = loadState();
  state.lastPing[handle] = timestamp.toISOString();
  if (meta) {
    if (!state.lastPingMeta) state.lastPingMeta = {};
    state.lastPingMeta[handle] = meta;
  }
  saveState(state);
}

export function getLastPingMeta(handle: string): PingMeta | null {
  const state = loadState();
  return state.lastPingMeta?.[handle] ?? null;
}

export function getLastPing(handle: string): Date | null {
  const state = loadState();
  const iso = state.lastPing[handle];
  if (!iso) return null;
  return new Date(iso);
}

export function getWindowReset(
  handle: string,
  now: Date = new Date(),
): { resetAt: Date; remainingMs: number } | null {
  const lastPing = getLastPing(handle);
  if (!lastPing) return null;
  const resetAt = new Date(lastPing.getTime() + QUOTA_WINDOW_MS);
  const remainingMs = resetAt.getTime() - now.getTime();
  if (remainingMs <= 0) return null;
  return { resetAt, remainingMs };
}

export function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return "expired";
  const totalMinutes = Math.ceil(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
