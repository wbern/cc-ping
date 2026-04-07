import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigDir } from "./paths.js";
import type { PingMeta, PingState } from "./types.js";

export const QUOTA_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours

export function loadState(): PingState {
  const stateFile = join(resolveConfigDir(), "state.json");
  if (!existsSync(stateFile)) {
    return { lastPing: {} };
  }
  try {
    const raw = readFileSync(stateFile, "utf-8");
    return JSON.parse(raw) as PingState;
  } catch {
    return { lastPing: {} };
  }
}

export function saveState(state: PingState): void {
  const configDir = resolveConfigDir();
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  );
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
  if (remainingMs > QUOTA_WINDOW_MS) return null;
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
