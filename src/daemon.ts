import { execSync, spawn } from "node:child_process";
import {
  existsSync,
  closeSync as fsCloseSync,
  openSync as fsOpenSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveConfigDir } from "./paths.js";
import { QUOTA_WINDOW_MS } from "./state.js";
import type { AccountConfig, DaemonState } from "./types.js";

// --- Constants ---

const GRACEFUL_POLL_MS = 500;
const GRACEFUL_POLL_ATTEMPTS = 20; // 20 × 500ms = 10s
const POST_KILL_DELAY_MS = 1000;

// --- File path helpers ---

export function daemonPidPath(): string {
  return join(resolveConfigDir(), "daemon.json");
}

export function daemonLogPath(): string {
  return join(resolveConfigDir(), "daemon.log");
}

export function daemonStopPath(): string {
  return join(resolveConfigDir(), "daemon.stop");
}

// --- PID file management ---

export function writeDaemonState(state: DaemonState): void {
  const configDir = resolveConfigDir();
  mkdirSync(configDir, { recursive: true });
  writeFileSync(daemonPidPath(), `${JSON.stringify(state, null, 2)}\n`);
}

export function readDaemonState(): DaemonState | null {
  const pidPath = daemonPidPath();
  if (!existsSync(pidPath)) return null;
  try {
    const raw = readFileSync(pidPath, "utf-8");
    return JSON.parse(raw) as DaemonState;
  } catch {
    return null;
  }
}

export function removeDaemonState(): boolean {
  const pidPath = daemonPidPath();
  if (!existsSync(pidPath)) return false;
  unlinkSync(pidPath);
  return true;
}

// --- Process checking ---

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    /* c8 ignore next -- EPERM requires foreign-owned process */
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

/* c8 ignore start -- subprocess call, tested via DI in getDaemonStatus */
function isDaemonProcess(pid: number): boolean {
  try {
    const output = execSync(`ps -p ${pid} -o command=`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output.includes("cc-ping");
  } catch {
    return false;
  }
}
/* c8 ignore stop */

// --- Parsing ---

export function parseInterval(value: string | undefined): number {
  if (!value) return QUOTA_WINDOW_MS;
  const minutes = Number(value);
  if (Number.isNaN(minutes)) {
    throw new Error(`Invalid interval value: ${value}`);
  }
  if (minutes <= 0) {
    throw new Error("Interval must be a positive number");
  }
  return minutes * 60 * 1000;
}

// --- Status ---

interface DaemonStatusResult {
  running: boolean;
  pid?: number;
  startedAt?: string;
  intervalMs?: number;
  uptime?: string;
  nextPingIn?: string;
}

export function getDaemonStatus(deps?: {
  isDaemonProcess?: (pid: number) => boolean;
}): DaemonStatusResult {
  /* c8 ignore next -- real isDaemonProcess uses execSync, tested via DI */
  const _isDaemonProcess = deps?.isDaemonProcess ?? isDaemonProcess;
  const state = readDaemonState();
  if (!state) return { running: false };

  if (!isProcessRunning(state.pid) || !_isDaemonProcess(state.pid)) {
    removeDaemonState();
    return { running: false };
  }

  const startedAt = new Date(state.startedAt);
  const uptimeMs = Date.now() - startedAt.getTime();
  const uptime = formatUptime(uptimeMs);

  let nextPingIn: string | undefined;
  if (state.lastPingAt) {
    const nextPingMs =
      new Date(state.lastPingAt).getTime() + state.intervalMs - Date.now();
    nextPingIn = formatUptime(Math.max(0, nextPingMs));
  }

  return {
    running: true,
    pid: state.pid,
    startedAt: state.startedAt,
    intervalMs: state.intervalMs,
    uptime,
    nextPingIn,
  };
}

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// --- Daemon loop ---

interface DaemonLoopDeps {
  runPing: (
    accounts: AccountConfig[],
    options: {
      parallel: boolean;
      quiet: boolean;
      bell?: boolean;
      notify?: boolean;
      wakeDelayMs?: number;
    },
  ) => Promise<number>;
  listAccounts: () => AccountConfig[];
  sleep: (ms: number) => Promise<void>;
  shouldStop: () => boolean;
  log: (msg: string) => void;
  updateState?: (patch: Partial<DaemonState>) => void;
  isWindowActive?: (handle: string) => boolean;
}

export async function daemonLoop(
  intervalMs: number,
  options: { quiet?: boolean; bell?: boolean; notify?: boolean },
  deps: DaemonLoopDeps,
): Promise<void> {
  let wakeDelayMs: number | undefined;
  while (!deps.shouldStop()) {
    const allAccounts = deps.listAccounts();
    const accounts = deps.isWindowActive
      ? allAccounts.filter((a) => !deps.isWindowActive!(a.handle))
      : allAccounts;
    const skipped = allAccounts.length - accounts.length;

    if (skipped > 0) {
      deps.log(`Skipping ${skipped} account(s) with active window`);
    }

    if (accounts.length === 0) {
      deps.log(
        allAccounts.length === 0
          ? "No accounts configured, waiting..."
          : "All accounts have active windows, waiting...",
      );
    } else {
      deps.log(
        `[${new Date().toISOString()}] Pinging ${accounts.length} account(s)...`,
      );
      await deps.runPing(accounts, {
        parallel: false,
        quiet: options.quiet ?? true,
        bell: options.bell,
        notify: options.notify,
        wakeDelayMs,
      });
      deps.updateState?.({ lastPingAt: new Date().toISOString() });
    }

    if (deps.shouldStop()) break;
    deps.log(`Sleeping ${Math.round(intervalMs / 60_000)}m until next ping...`);
    const sleepStart = Date.now();
    await deps.sleep(intervalMs);
    const overshootMs = Date.now() - sleepStart - intervalMs;
    if (overshootMs > 60_000) {
      wakeDelayMs = overshootMs;
      deps.log(`Woke ${formatUptime(overshootMs)} late (system sleep?)`);
    } else {
      wakeDelayMs = undefined;
    }
  }
}

// --- Start ---

interface StartDaemonDeps {
  spawn: typeof spawn;
  getDaemonStatus: () => DaemonStatusResult;
  writeDaemonState: (state: DaemonState) => void;
  openSync: (path: string, flags: string) => number;
  closeSync: (fd: number) => void;
}

export function startDaemon(
  options: {
    interval?: string;
    quiet?: boolean;
    bell?: boolean;
    notify?: boolean;
  },
  deps?: Partial<StartDaemonDeps>,
): { success: boolean; pid?: number; error?: string } {
  /* c8 ignore next 5 -- production defaults */
  const _getDaemonStatus = deps?.getDaemonStatus ?? getDaemonStatus;
  const _spawn = deps?.spawn ?? spawn;
  const _writeDaemonState = deps?.writeDaemonState ?? writeDaemonState;
  const _openSync = deps?.openSync ?? fsOpenSync;
  const _closeSync = deps?.closeSync ?? fsCloseSync;

  const status = _getDaemonStatus();
  if (status.running) {
    return {
      success: false,
      pid: status.pid,
      error: "Daemon is already running",
    };
  }

  let intervalMs: number;
  try {
    intervalMs = parseInterval(options.interval);
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }

  const configDir = resolveConfigDir();
  mkdirSync(configDir, { recursive: true });

  const logPath = daemonLogPath();
  const logFd = _openSync(logPath, "a");

  const args = ["daemon", "_run", "--interval-ms", String(intervalMs)];
  if (options.quiet) args.push("--quiet");
  if (options.bell) args.push("--bell");
  if (options.notify) args.push("--notify");

  const child = _spawn(process.execPath, [process.argv[1], ...args], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });

  if (!child.pid) {
    _closeSync(logFd);
    return { success: false, error: "Failed to spawn daemon process" };
  }

  child.unref();
  _closeSync(logFd);

  _writeDaemonState({
    pid: child.pid,
    startedAt: new Date().toISOString(),
    intervalMs,
    configDir,
  });

  return { success: true, pid: child.pid };
}

// --- Stop ---

interface StopDaemonDeps {
  getDaemonStatus: () => DaemonStatusResult;
  writeStopFile: () => void;
  isProcessRunning: (pid: number) => boolean;
  removeDaemonState: () => boolean;
  removeStopFile: () => void;
  sleep: (ms: number) => Promise<void>;
  kill: (pid: number) => void;
}

export async function stopDaemon(
  deps?: Partial<StopDaemonDeps>,
): Promise<{ success: boolean; pid?: number; error?: string }> {
  /* c8 ignore next -- production default */
  const _getDaemonStatus = deps?.getDaemonStatus ?? getDaemonStatus;
  const _writeStopFile =
    deps?.writeStopFile ??
    /* c8 ignore next 5 -- production default */
    (() => {
      const configDir = resolveConfigDir();
      mkdirSync(configDir, { recursive: true });
      writeFileSync(daemonStopPath(), "");
    });
  /* c8 ignore next 2 -- production defaults */
  const _isProcessRunning = deps?.isProcessRunning ?? isProcessRunning;
  const _removeDaemonState = deps?.removeDaemonState ?? removeDaemonState;
  const _removeStopFile =
    deps?.removeStopFile ??
    /* c8 ignore next 4 -- production default */
    (() => {
      const stopPath = daemonStopPath();
      if (existsSync(stopPath)) unlinkSync(stopPath);
    });
  /* c8 ignore next 3 -- production default */
  const _sleep =
    deps?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /* c8 ignore next -- production default */
  const _kill =
    deps?.kill ??
    /* c8 ignore next 7 -- production default */
    ((pid: number) => {
      if (process.platform === "win32") {
        execSync(`taskkill /PID ${pid}`);
      } else {
        process.kill(pid, "SIGTERM");
      }
    });

  const status = _getDaemonStatus();
  if (!status.running || !status.pid) {
    return { success: false, error: "Daemon is not running" };
  }

  const pid = status.pid;
  _writeStopFile();

  // Poll for graceful exit
  for (let i = 0; i < GRACEFUL_POLL_ATTEMPTS; i++) {
    await _sleep(GRACEFUL_POLL_MS);
    if (!_isProcessRunning(pid)) {
      _removeDaemonState();
      _removeStopFile();
      return { success: true, pid };
    }
  }

  // Fallback: force kill
  try {
    _kill(pid);
  } catch {
    // Process may have already exited
  }

  await _sleep(POST_KILL_DELAY_MS);
  _removeDaemonState();
  _removeStopFile();
  return { success: true, pid };
}

// --- Run (called by _run subcommand) ---

interface RunDaemonDeps extends DaemonLoopDeps {
  onSignal: (signal: string, handler: () => void) => void;
  removeSignal: (signal: string, handler: () => void) => void;
  exit: (code: number) => void;
}

export async function runDaemon(
  intervalMs: number,
  options: { quiet?: boolean; bell?: boolean; notify?: boolean },
  deps: RunDaemonDeps,
): Promise<void> {
  const stopPath = daemonStopPath();

  const cleanup = () => {
    if (existsSync(stopPath)) unlinkSync(stopPath);
    removeDaemonState();
  };

  const onSigterm = () => {
    deps.log("Received SIGTERM, shutting down...");
    cleanup();
    deps.exit(0);
  };

  const onSigint = () => {
    deps.log("Received SIGINT, shutting down...");
    cleanup();
    deps.exit(0);
  };

  deps.onSignal("SIGTERM", onSigterm);
  deps.onSignal("SIGINT", onSigint);

  deps.log(`Daemon started. Interval: ${Math.round(intervalMs / 60_000)}m`);

  try {
    await daemonLoop(intervalMs, options, deps);
  } finally {
    deps.removeSignal("SIGTERM", onSigterm);
    deps.removeSignal("SIGINT", onSigint);

    deps.log("Daemon stopping...");
    cleanup();
  }
}

/* c8 ignore start -- production wiring only */
export async function runDaemonWithDefaults(
  intervalMs: number,
  options: { quiet?: boolean; bell?: boolean; notify?: boolean },
): Promise<void> {
  const stopPath = daemonStopPath();
  const { runPing } = await import("./run-ping.js");
  const { listAccounts } = await import("./config.js");
  const { getWindowReset } = await import("./state.js");

  await runDaemon(intervalMs, options, {
    runPing,
    listAccounts,
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    shouldStop: () => existsSync(stopPath),
    log: (msg) => console.log(msg),
    isWindowActive: (handle) => getWindowReset(handle) !== null,
    updateState: (patch) => {
      const current = readDaemonState();
      if (current) writeDaemonState({ ...current, ...patch });
    },
    onSignal: (signal, handler) => process.on(signal, handler),
    removeSignal: (signal, handler) => process.removeListener(signal, handler),
    exit: (code) => process.exit(code),
  });
}
/* c8 ignore stop */
