import { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { formatExecError } from "./ping.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

const { pingAccounts } = await import("./ping.js");

const validJson = JSON.stringify({
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
  model_usage: { "claude-sonnet-4-20250514": {} },
});

const errorJson = JSON.stringify({
  type: "result",
  subtype: "error_max_turns",
  session_id: "sess-2",
  duration_ms: 500,
  duration_api_ms: 400,
  is_error: true,
  num_turns: 1,
  result: "error occurred",
  total_cost_usd: 0.001,
  usage: {
    input_tokens: 5,
    output_tokens: 2,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  model_usage: { "claude-sonnet-4-20250514": {} },
});

function setupMock(error: Error | null, stdout = "") {
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      setTimeout(
        () =>
          (cb as (err: Error | null, stdout: string, stderr: string) => void)(
            error,
            stdout,
            "",
          ),
        10,
      );
      return { stdin: { end: vi.fn() } } as unknown as ReturnType<
        typeof execFile
      >;
    },
  );
}

describe("pingAccounts", () => {
  it("pings accounts sequentially by default", async () => {
    setupMock(null, validJson);
    const accounts = [
      { handle: "a", configDir: "/tmp/a" },
      { handle: "b", configDir: "/tmp/b" },
    ];
    const results = await pingAccounts(accounts);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.success).toBe(true);
      expect(r.error).toBeUndefined();
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("pings accounts in parallel when option set", async () => {
    setupMock(null, validJson);
    const accounts = [
      { handle: "a", configDir: "/tmp/a" },
      { handle: "b", configDir: "/tmp/b" },
    ];
    const results = await pingAccounts(accounts, { parallel: true });
    expect(results).toHaveLength(2);
  });

  it("reports failure when execFile returns an error", async () => {
    setupMock(new Error("Command timed out"));
    const results = await pingAccounts([
      { handle: "fail", configDir: "/tmp/fail" },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe("Command timed out");
  });

  it("includes claudeResponse when stdout has valid JSON", async () => {
    setupMock(null, validJson);
    const results = await pingAccounts([{ handle: "a", configDir: "/tmp/a" }]);
    expect(results[0].claudeResponse).toBeDefined();
    expect(results[0].claudeResponse!.session_id).toBe("sess-1");
    expect(results[0].claudeResponse!.total_cost_usd).toBe(0.003);
    expect(results[0].claudeResponse!.model).toBe("claude-sonnet-4-20250514");
  });

  it("succeeds without claudeResponse when stdout is empty", async () => {
    setupMock(null, "");
    const results = await pingAccounts([{ handle: "a", configDir: "/tmp/a" }]);
    expect(results[0].success).toBe(true);
    expect(results[0].claudeResponse).toBeUndefined();
  });

  it("marks success false when is_error is true in JSON", async () => {
    setupMock(null, errorJson);
    const results = await pingAccounts([{ handle: "a", configDir: "/tmp/a" }]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe("error_max_turns");
    expect(results[0].claudeResponse).toBeDefined();
    expect(results[0].claudeResponse!.is_error).toBe(true);
  });

  it("passes generated prompt and disables tools in CLI args", async () => {
    setupMock(null, validJson);
    await pingAccounts([{ handle: "a", configDir: "/tmp/a" }]);
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--tools");
    expect(args).toContain("");
    expect(args).toContain("--max-turns");
    expect(args).toContain("1");
    // Should use a generated prompt, not the literal "ping"
    const promptIdx = args.indexOf("-p");
    expect(args[promptIdx + 1]).not.toBe("ping");
    expect(args[promptIdx + 1]).toMatch(/\d+/);
    expect(mockExecFile).toHaveBeenCalledWith(
      "claude",
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ CLAUDE_CONFIG_DIR: "/tmp/a" }),
        timeout: 30_000,
      }),
      expect.any(Function),
    );
  });

  it("shows timed out instead of raw command on timeout error", async () => {
    const err = Object.assign(
      new Error("Command failed: claude -p ping --output-format json --tools "),
      { killed: true, signal: "SIGTERM" },
    );
    setupMock(err);
    const results = await pingAccounts([
      { handle: "timeout", configDir: "/tmp/timeout" },
    ]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe("timed out");
  });

  it("prefers claudeResponse subtype over execFile error", async () => {
    const err = new Error(
      "Command failed: claude -p ping --output-format json --tools ",
    );
    setupMock(err, errorJson);
    const results = await pingAccounts([
      { handle: "err", configDir: "/tmp/err" },
    ]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe("error_max_turns");
  });
});

describe("formatExecError", () => {
  it("returns timed out for killed process", () => {
    const err = Object.assign(new Error("Command failed: claude ..."), {
      killed: true,
      signal: "SIGTERM",
    });
    expect(formatExecError(err)).toBe("timed out");
  });

  it("returns cleaned message for command failed", () => {
    const err = new Error(
      "Command failed: claude -p ping --output-format json --tools ",
    );
    expect(formatExecError(err)).toBe("command failed");
  });

  it("returns original message for other errors", () => {
    const err = new Error("ENOENT: command not found");
    expect(formatExecError(err)).toBe("ENOENT: command not found");
  });
});
