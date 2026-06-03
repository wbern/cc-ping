import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  daemonHeartbeatPath,
  isProcessRunning,
  readDaemonState,
  writeDaemonState,
} from "./daemon.js";
import {
  DEFAULT_HEARTBEAT_STALE_MS,
  readHeartbeatAge,
  runHealthcheck,
  runHealthcheckWithDefaults,
} from "./watchdog.js";

describe("runHealthcheck", () => {
  it("force-kills a running daemon whose heartbeat has gone stale", () => {
    const killed: number[] = [];
    const result = runHealthcheck({
      readState: () => ({
        pid: 784,
        startedAt: "2026-06-02T05:56:27.000Z",
        intervalMs: 18_000_000,
        configDir: "/tmp/cc-ping",
      }),
      isRunning: () => true,
      heartbeatAgeMs: () => 200_000,
      staleMs: 180_000,
      kill: (pid) => killed.push(pid),
      clearState: () => {},
      log: () => {},
    });

    expect(killed).toEqual([784]);
    expect(result).toBe("restarted");
  });

  it("never kills a running daemon when no heartbeat file exists yet", () => {
    const killed: number[] = [];
    const result = runHealthcheck({
      readState: () => ({
        pid: 784,
        startedAt: "2026-06-02T05:56:27.000Z",
        intervalMs: 18_000_000,
        configDir: "/tmp/cc-ping",
      }),
      isRunning: () => true,
      heartbeatAgeMs: () => null,
      kill: (pid) => killed.push(pid),
      clearState: () => {},
      log: () => {},
    });

    expect(killed).toEqual([]);
    expect(result).toBe("no-heartbeat");
  });

  it("does nothing when no daemon is recorded", () => {
    const killed: number[] = [];
    const result = runHealthcheck({
      readState: () => null,
      isRunning: () => true,
      heartbeatAgeMs: () => 999_999,
      kill: (pid) => killed.push(pid),
      clearState: () => {},
      log: () => {},
    });

    expect(killed).toEqual([]);
    expect(result).toBe("no-daemon");
  });

  it("treats a recorded pid that is no longer alive as no daemon", () => {
    const killed: number[] = [];
    const result = runHealthcheck({
      readState: () => ({
        pid: 784,
        startedAt: "2026-06-02T05:56:27.000Z",
        intervalMs: 18_000_000,
        configDir: "/tmp/cc-ping",
      }),
      isRunning: () => false,
      heartbeatAgeMs: () => 999_999,
      kill: (pid) => killed.push(pid),
      clearState: () => {},
      log: () => {},
    });

    expect(killed).toEqual([]);
    expect(result).toBe("no-daemon");
  });

  it("leaves a healthy daemon with a fresh heartbeat untouched", () => {
    const killed: number[] = [];
    const result = runHealthcheck({
      readState: () => ({
        pid: 784,
        startedAt: "2026-06-02T05:56:27.000Z",
        intervalMs: 18_000_000,
        configDir: "/tmp/cc-ping",
      }),
      isRunning: () => true,
      heartbeatAgeMs: () => 12_000,
      kill: (pid) => killed.push(pid),
      clearState: () => {},
      log: () => {},
    });

    expect(killed).toEqual([]);
    expect(result).toBe("healthy");
  });

  it("uses the default stale threshold when none is provided", () => {
    const killed: number[] = [];
    const result = runHealthcheck({
      readState: () => ({
        pid: 784,
        startedAt: "2026-06-02T05:56:27.000Z",
        intervalMs: 18_000_000,
        configDir: "/tmp/cc-ping",
      }),
      isRunning: () => true,
      heartbeatAgeMs: () => DEFAULT_HEARTBEAT_STALE_MS + 1,
      kill: (pid) => killed.push(pid),
      clearState: () => {},
      log: () => {},
    });

    expect(killed).toEqual([784]);
    expect(result).toBe("restarted");
  });
});

describe("readHeartbeatAge", () => {
  it("returns the elapsed time since the heartbeat was last written", () => {
    const age = readHeartbeatAge({
      path: () => "/tmp/cc-ping/daemon.heartbeat",
      mtimeMs: () => 1_000_000,
      now: () => 1_200_000,
    });
    expect(age).toBe(200_000);
  });

  it("returns null when the heartbeat file cannot be read", () => {
    const age = readHeartbeatAge({
      path: () => "/tmp/cc-ping/daemon.heartbeat",
      mtimeMs: () => {
        throw new Error("ENOENT");
      },
      now: () => 1_200_000,
    });
    expect(age).toBeNull();
  });
});

// These exercise the real filesystem path that production uses
// (statSync(...).mtimeMs) rather than a mocked mtime, proving a freshly
// written heartbeat reads as healthy and a backdated one drives a restart.
describe("heartbeat staleness against the real filesystem", () => {
  let dir: string;
  let beat: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-ping-watchdog-"));
    beat = join(dir, "daemon.heartbeat");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const realAge = () =>
    readHeartbeatAge({
      path: () => beat,
      mtimeMs: (p) => statSync(p).mtimeMs,
      now: () => Date.now(),
    });

  it("reads a just-written heartbeat as fresh, below the stale threshold", () => {
    writeFileSync(beat, `${new Date().toISOString()}\n`);
    const age = realAge();
    expect(age).not.toBeNull();
    expect(age as number).toBeLessThan(DEFAULT_HEARTBEAT_STALE_MS);
  });

  it("force-restarts a live daemon once a backdated heartbeat reads as stale", () => {
    writeFileSync(beat, `${new Date().toISOString()}\n`);
    const past = (Date.now() - 10 * 60 * 1000) / 1000;
    utimesSync(beat, past, past);

    const age = realAge();
    expect(age as number).toBeGreaterThan(DEFAULT_HEARTBEAT_STALE_MS);

    const killed: number[] = [];
    const cleared: boolean[] = [];
    const result = runHealthcheck({
      readState: () => ({
        pid: 4242,
        startedAt: "2026-06-02T05:56:27.000Z",
        intervalMs: 18_000_000,
        configDir: dir,
      }),
      isRunning: () => true,
      heartbeatAgeMs: realAge,
      kill: (pid) => killed.push(pid),
      clearState: () => cleared.push(true),
      log: () => {},
    });

    expect(result).toBe("restarted");
    expect(killed).toEqual([4242]);
    expect(cleared).toEqual([true]);
  });

  it("reads a missing heartbeat file as null", () => {
    expect(realAge()).toBeNull();
  });
});

// Drives the real production entry point end to end: a real live process whose
// heartbeat has gone stale is force-killed with SIGKILL and its state files are
// cleared — everything the launchd/systemd watchdog relies on, minus the
// service manager's relaunch.
describe("runHealthcheckWithDefaults against a real wedged process", () => {
  let dir: string;
  let child: ChildProcess | undefined;
  const prevConfig = process.env.CC_PING_CONFIG;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cc-ping-recover-"));
    process.env.CC_PING_CONFIG = dir;
  });

  afterEach(() => {
    if (child && child.exitCode === null && child.pid)
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    child = undefined;
    if (prevConfig === undefined) delete process.env.CC_PING_CONFIG;
    else process.env.CC_PING_CONFIG = prevConfig;
    rmSync(dir, { recursive: true, force: true });
  });

  const exited = (proc: ChildProcess) =>
    new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
      proc.on("exit", () => resolve());
    });

  it("force-kills the recorded pid and clears the state and heartbeat files", async () => {
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"]);
    const pid = child.pid as number;
    expect(isProcessRunning(pid)).toBe(true);

    writeDaemonState({
      pid,
      startedAt: "2026-06-02T05:56:27.000Z",
      intervalMs: 18_000_000,
      configDir: dir,
    });
    writeFileSync(daemonHeartbeatPath(), `${new Date().toISOString()}\n`);
    const past = (Date.now() - 10 * 60 * 1000) / 1000;
    utimesSync(daemonHeartbeatPath(), past, past);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = runHealthcheckWithDefaults();
    log.mockRestore();

    expect(result).toBe("restarted");
    await exited(child);
    expect(isProcessRunning(pid)).toBe(false);
    expect(readDaemonState()).toBeNull();
    expect(existsSync(daemonHeartbeatPath())).toBe(false);
  });

  it("leaves a healthy process with a fresh heartbeat running", () => {
    child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e9)"]);
    const pid = child.pid as number;

    writeDaemonState({
      pid,
      startedAt: "2026-06-02T05:56:27.000Z",
      intervalMs: 18_000_000,
      configDir: dir,
    });
    writeFileSync(daemonHeartbeatPath(), `${new Date().toISOString()}\n`);

    const result = runHealthcheckWithDefaults();

    expect(result).toBe("healthy");
    expect(isProcessRunning(pid)).toBe(true);
    expect(readDaemonState()).not.toBeNull();
  });
});
