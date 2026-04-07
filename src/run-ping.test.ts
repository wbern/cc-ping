import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => join(tmpdir(), `cc-ping-runping-${process.pid}`),
  };
});

vi.mock("./ping.js", () => ({
  pingAccounts: vi.fn(),
}));

vi.mock("./bell.js", () => ({
  ringBell: vi.fn(),
}));

vi.mock("./notify.js", () => ({
  sendNotification: vi.fn().mockResolvedValue(true),
}));

const { pingAccounts } = await import("./ping.js");
const { ringBell } = await import("./bell.js");
const { sendNotification } = await import("./notify.js");
const { readHistory } = await import("./history.js");
const { recordPing } = await import("./state.js");
const { runPing } = await import("./run-ping.js");

const mockPingAccounts = vi.mocked(pingAccounts);
const mockRingBell = vi.mocked(ringBell);
const mockSendNotification = vi.mocked(sendNotification);

describe("runPing", () => {
  const stateDir = join(
    tmpdir(),
    `cc-ping-runping-${process.pid}`,
    ".config",
    "cc-ping",
  );

  beforeEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("returns exit code 0 when all pings succeed", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: true, durationMs: 100 },
    ]);
    const stdout = vi.fn();
    const stderr = vi.fn();
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    const exitCode = await runPing(accounts, {
      parallel: false,
      quiet: false,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(0);
  });

  it("returns exit code 1 when any ping fails", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: true, durationMs: 100 },
      { handle: "bob", success: false, durationMs: 200, error: "timed out" },
    ]);
    const stdout = vi.fn();
    const stderr = vi.fn();
    const accounts = [
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ];

    const exitCode = await runPing(accounts, {
      parallel: false,
      quiet: false,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
  });

  it("suppresses all stdout in quiet mode", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: true, durationMs: 100 },
    ]);
    const stdout = vi.fn();
    const stderr = vi.fn();
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    await runPing(accounts, {
      parallel: false,
      quiet: true,
      stdout,
      stderr,
    });

    expect(stdout).not.toHaveBeenCalled();
  });

  it("outputs failure count to stderr in quiet mode", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: false, durationMs: 100, error: "timed out" },
    ]);
    const stdout = vi.fn();
    const stderr = vi.fn();
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    const exitCode = await runPing(accounts, {
      parallel: false,
      quiet: true,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith("1/1 failed");
  });

  it("logs per-account results when not quiet", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: true, durationMs: 150 },
      { handle: "bob", success: false, durationMs: 200, error: "timed out" },
    ]);
    const stdout = vi.fn();
    const stderr = vi.fn();
    const accounts = [
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ];

    await runPing(accounts, {
      parallel: false,
      quiet: false,
      stdout,
      stderr,
    });

    const allOutput = stdout.mock.calls.map((c) => c[0]).join("\n");
    expect(allOutput).toContain("alice: ok");
    expect(allOutput).toContain("bob: FAIL");
    expect(allOutput).toContain("timed out");
  });

  it("displays cost info when claudeResponse is present", async () => {
    mockPingAccounts.mockResolvedValue([
      {
        handle: "alice",
        success: true,
        durationMs: 100,
        claudeResponse: {
          type: "result",
          subtype: "success",
          session_id: "sess-1",
          duration_ms: 1000,
          duration_api_ms: 800,
          is_error: false,
          num_turns: 1,
          result: "pong",
          total_cost_usd: 0.003,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          model: "claude-sonnet-4-20250514",
        },
      },
    ]);
    const stdout = vi.fn();
    const stderr = vi.fn();
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    await runPing(accounts, {
      parallel: false,
      quiet: false,
      stdout,
      stderr,
    });

    const allOutput = stdout.mock.calls.map((c) => c[0]).join("\n");
    expect(allOutput).toContain("$0.0030");
    expect(allOutput).toContain("15 tok");
  });

  it("records history entries for all ping results", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: true, durationMs: 100 },
      { handle: "bob", success: false, durationMs: 200, error: "timed out" },
    ]);
    const accounts = [
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ];

    await runPing(accounts, {
      parallel: false,
      quiet: false,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    const history = readHistory();
    expect(history).toHaveLength(2);
    expect(history[0].handle).toBe("alice");
    expect(history[0].success).toBe(true);
    expect(history[1].handle).toBe("bob");
    expect(history[1].success).toBe(false);
    expect(history[1].error).toBe("timed out");
  });

  it("outputs JSON when json option is true", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: true, durationMs: 100 },
      { handle: "bob", success: false, durationMs: 200, error: "timed out" },
    ]);
    const stdout = vi.fn();
    const stderr = vi.fn();
    const accounts = [
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ];

    const exitCode = await runPing(accounts, {
      parallel: false,
      quiet: false,
      json: true,
      stdout,
      stderr,
    });

    expect(exitCode).toBe(1);
    expect(stdout).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(stdout.mock.calls[0][0]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].handle).toBe("alice");
    expect(parsed[0].success).toBe(true);
    expect(parsed[1].handle).toBe("bob");
    expect(parsed[1].success).toBe(false);
    expect(parsed[1].error).toBe("timed out");
  });

  it("defaults to console.log when stdout not provided", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: true, durationMs: 100 },
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    await runPing(accounts, { parallel: false, quiet: false });

    expect(logSpy).toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("returns exit code 0 for JSON output when all pings succeed", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: true, durationMs: 100 },
    ]);
    const stdout = vi.fn();
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    const exitCode = await runPing(accounts, {
      parallel: false,
      quiet: false,
      json: true,
      stdout,
      stderr: vi.fn(),
    });

    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout.mock.calls[0][0]);
    expect(parsed[0].success).toBe(true);
  });

  it("rings bell on failure when bell option is true", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: false, durationMs: 100, error: "timed out" },
    ]);
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    await runPing(accounts, {
      parallel: false,
      quiet: false,
      bell: true,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    expect(mockRingBell).toHaveBeenCalled();
  });

  it("does not ring bell on success even when bell option is true", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: true, durationMs: 100 },
    ]);
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    await runPing(accounts, {
      parallel: false,
      quiet: false,
      bell: true,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    expect(mockRingBell).not.toHaveBeenCalled();
  });

  it("does not ring bell when bell option is not set", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: false, durationMs: 100, error: "timed out" },
    ]);
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    await runPing(accounts, {
      parallel: false,
      quiet: false,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    expect(mockRingBell).not.toHaveBeenCalled();
  });

  it("staggers pings with delay between accounts", async () => {
    mockPingAccounts
      .mockResolvedValueOnce([
        { handle: "alice", success: true, durationMs: 100 },
      ])
      .mockResolvedValueOnce([
        { handle: "bob", success: true, durationMs: 100 },
      ]);
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const accounts = [
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ];

    await runPing(accounts, {
      parallel: false,
      quiet: false,
      staggerMs: 60_000,
      stdout: vi.fn(),
      stderr: vi.fn(),
      _sleep: sleepFn,
    });

    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).toHaveBeenCalledWith(60_000);
    expect(mockPingAccounts).toHaveBeenCalledTimes(2);
  });

  it("uses default sleep when _sleep not provided", async () => {
    vi.useFakeTimers();
    mockPingAccounts
      .mockResolvedValueOnce([
        { handle: "alice", success: true, durationMs: 100 },
      ])
      .mockResolvedValueOnce([
        { handle: "bob", success: true, durationMs: 100 },
      ]);
    const accounts = [
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ];

    const promise = runPing(accounts, {
      parallel: false,
      quiet: false,
      staggerMs: 1000,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    vi.useRealTimers();

    expect(mockPingAccounts).toHaveBeenCalledTimes(2);
  });

  it("does not stagger with a single account", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: true, durationMs: 100 },
    ]);
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    await runPing(accounts, {
      parallel: false,
      quiet: false,
      staggerMs: 60_000,
      stdout: vi.fn(),
      stderr: vi.fn(),
      _sleep: sleepFn,
    });

    expect(sleepFn).not.toHaveBeenCalled();
  });

  it("sends desktop notification on failure when notify is true", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: false, durationMs: 100, error: "timed out" },
    ]);
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    await runPing(accounts, {
      parallel: false,
      quiet: false,
      notify: true,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    expect(mockSendNotification).toHaveBeenCalledWith(
      "cc-ping: ping failure",
      "1 account(s) failed: alice",
    );
  });

  it("sends new window notification with sound when ping succeeds with no prior window", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: true, durationMs: 100 },
    ]);
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    await runPing(accounts, {
      parallel: false,
      quiet: false,
      notify: true,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    expect(mockSendNotification).toHaveBeenCalledWith(
      "cc-ping: new window",
      "1 account(s) ready: alice",
      { sound: true },
    );
  });

  it("does not send notification when notify is not set", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: false, durationMs: 100, error: "timed out" },
    ]);
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    await runPing(accounts, {
      parallel: false,
      quiet: false,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("does not send new window notification when account already has active window", async () => {
    recordPing("alice", new Date());
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: true, durationMs: 100 },
    ]);
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    await runPing(accounts, {
      parallel: false,
      quiet: false,
      notify: true,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("does not send new window notification when notify is not set", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: true, durationMs: 100 },
    ]);
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    await runPing(accounts, {
      parallel: false,
      quiet: false,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    expect(mockSendNotification).not.toHaveBeenCalled();
  });

  it("sends both failure and new window notifications when mixed results", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: true, durationMs: 100 },
      { handle: "bob", success: false, durationMs: 200, error: "timed out" },
    ]);
    const accounts = [
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ];

    await runPing(accounts, {
      parallel: false,
      quiet: false,
      notify: true,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    expect(mockSendNotification).toHaveBeenCalledWith(
      "cc-ping: ping failure",
      "1 account(s) failed: bob",
    );
    expect(mockSendNotification).toHaveBeenCalledWith(
      "cc-ping: new window",
      "1 account(s) ready: alice",
      { sound: true },
    );
  });

  it("includes wake delay in new window notification when wakeDelayMs is set", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: true, durationMs: 100 },
    ]);
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    await runPing(accounts, {
      parallel: false,
      quiet: false,
      notify: true,
      wakeDelayMs: 2 * 60 * 60 * 1000 + 15 * 60 * 1000, // 2h 15m
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    expect(mockSendNotification).toHaveBeenCalledWith(
      "cc-ping: new window",
      "1 account(s) ready: alice (woke 2h 15m late)",
      { sound: true },
    );
  });

  it("does not include wake delay in notification when wakeDelayMs is not set", async () => {
    mockPingAccounts.mockResolvedValue([
      { handle: "alice", success: true, durationMs: 100 },
    ]);
    const accounts = [{ handle: "alice", configDir: "/tmp/alice" }];

    await runPing(accounts, {
      parallel: false,
      quiet: false,
      notify: true,
      stdout: vi.fn(),
      stderr: vi.fn(),
    });

    expect(mockSendNotification).toHaveBeenCalledWith(
      "cc-ping: new window",
      "1 account(s) ready: alice",
      { sound: true },
    );
  });
});
