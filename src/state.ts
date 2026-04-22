import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveConfigDir } from "./paths.js";
import type { PingMeta, PingState } from "./types.js";

export const QUOTA_WINDOW_MS = 5 * 60 * 60 * 1000; // 5 hours

interface SaveStateDeps {
  mkdirSync: (path: string, opts: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
  renameSync: (from: string, to: string) => void;
}

export function loadState(): PingState {
  const stateFile = join(resolveConfigDir(), "state.json");
  if (!existsSync(stateFile)) {
    return { lastPing: {} };
  }
  try {
    const raw = readFileSync(stateFile, "utf-8");
    return JSON.parse(raw) as PingState;
  } catch {
    try {
      renameSync(stateFile, `${stateFile}.corrupt`);
      /* c8 ignore start -- quarantine is best-effort; preserve no-throw contract */
    } catch {}
    /* c8 ignore stop */
    return { lastPing: {} };
  }
}

export function saveState(
  state: PingState,
  deps?: Partial<SaveStateDeps>,
): void {
  /* c8 ignore next 3 -- production defaults */
  const _mkdirSync = deps?.mkdirSync ?? mkdirSync;
  const _writeFileSync = deps?.writeFileSync ?? writeFileSync;
  const _renameSync = deps?.renameSync ?? renameSync;
  const configDir = resolveConfigDir();
  _mkdirSync(configDir, { recursive: true });
  const target = join(configDir, "state.json");
  const tmp = `${target}.tmp`;
  _writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  _renameSync(tmp, target);
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

export function clearPingState(handle: string): boolean {
  const state = loadState();
  let changed = false;
  if (handle in state.lastPing) {
    delete state.lastPing[handle];
    changed = true;
  }
  if (state.lastPingMeta && handle in state.lastPingMeta) {
    delete state.lastPingMeta[handle];
    changed = true;
  }
  if (changed) saveState(state);
  return changed;
}

function collectOrphans(state: PingState, activeHandles: string[]): string[] {
  const active = new Set(activeHandles);
  const orphans = new Set<string>();
  for (const h of Object.keys(state.lastPing)) {
    if (!active.has(h)) orphans.add(h);
  }
  if (state.lastPingMeta) {
    for (const h of Object.keys(state.lastPingMeta)) {
      if (!active.has(h)) orphans.add(h);
    }
  }
  return [...orphans];
}

export function findOrphanHandles(activeHandles: string[]): string[] {
  return collectOrphans(loadState(), activeHandles);
}

export function pruneOrphanState(activeHandles: string[]): string[] {
  const state = loadState();
  const orphans = collectOrphans(state, activeHandles);
  if (orphans.length === 0) return [];
  for (const h of orphans) {
    delete state.lastPing[h];
    if (state.lastPingMeta) delete state.lastPingMeta[h];
  }
  saveState(state);
  return orphans;
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
