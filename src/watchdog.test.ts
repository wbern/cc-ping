import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEARTBEAT_STALE_MS,
  readHeartbeatAge,
  runHealthcheck,
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
