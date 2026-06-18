import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatExecError } from "./ping.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);
const mockSpawn = vi.mocked(spawn);

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

function apiErrorJson(status: number, result = "api error"): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "s",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    api_error_status: status,
    num_turns: 1,
    result,
    total_cost_usd: 0,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    model_usage: { "claude-sonnet-4-20250514": {} },
  });
}

function setupMock(error: Error | null, stdout = "") {
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      queueMicrotask(() =>
        (cb as (err: Error | null, stdout: string, stderr: string) => void)(
          error,
          stdout,
          "",
        ),
      );
      return { stdin: { end: vi.fn() } } as unknown as ReturnType<
        typeof execFile
      >;
    },
  );
}

interface MockSpawnResult {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
  stderr?: string;
  error?: Error;
  delayMs?: number;
}

function setupSpawnMock(result: MockSpawnResult = {}) {
  mockSpawn.mockImplementation(() => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      kill: vi.fn(() => true),
    }) as unknown as ReturnType<typeof spawn>;

    setTimeout(() => {
      if (result.error) {
        child.emit("error", result.error);
        child.emit("close", 1, null);
        return;
      }

      const code = result.code ?? 0;
      const successOutput =
        code === 0 && !result.signal
          ? "CC_PING_SUCCESS prompt_completed\n"
          : "";
      const stdoutText = result.stdout ?? successOutput;
      if (stdoutText) stdout.emit("data", Buffer.from(stdoutText));
      if (result.stderr) stderr.emit("data", Buffer.from(result.stderr));
      child.emit("close", code, result.signal ?? null);
    }, result.delayMs ?? 10);

    return child;
  });
}

describe("pingAccounts", () => {
  afterEach(() => {
    vi.useRealTimers();
    mockExecFile.mockReset();
    mockSpawn.mockReset();
  });

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
    expect(args).toContain("--model");
    expect(args).toContain("haiku");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--tools");
    expect(args).toContain("");
    expect(args).toContain("--max-turns");
    expect(args).toContain("1");
    // Should use a generated prompt, not the literal "ping"
    const promptIdx = args.indexOf("-p");
    expect(args[promptIdx + 1]).not.toBe("ping");
    expect(args[promptIdx + 1]).toBeTruthy();
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

  it("spawns claude from a neutral temp dir, not the inherited cwd", async () => {
    setupMock(null, validJson);
    await pingAccounts([{ handle: "a", configDir: "/tmp/a" }]);
    const opts = mockExecFile.mock.calls[0][2] as { cwd?: string };
    // Neutral cwd: no project context to load, never TCC-protected — so Claude
    // Code's startup reads can't be attributed to cc-ping accessing ~/Drive/etc.
    expect(opts.cwd).toBe(tmpdir());
  });

  it("passes configured model and prompt style to print mode", async () => {
    setupMock(null, validJson);
    await pingAccounts([{ handle: "a", configDir: "/tmp/a" }], {
      model: "sonnet",
      promptStyle: "chess",
    });
    const args = mockExecFile.mock.calls[0][1] as string[];
    expect(args).toEqual(expect.arrayContaining(["--model", "sonnet"]));
    expect(args[args.indexOf("-p") + 1]).toContain("FEN: ");
  });

  it("accepts legacy print as a backward-compatible print mode alias", async () => {
    setupMock(null, validJson);

    const results = await pingAccounts([{ handle: "a", configDir: "/tmp/a" }], {
      mode: "legacy-print",
    });

    expect(results[0].success).toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("launches Claude through expect when experimental interactive mode is configured", async () => {
    setupSpawnMock();

    await pingAccounts([{ handle: "a", configDir: "/tmp/a" }], {
      mode: "experimental-interactive",
      model: "sonnet",
      promptStyle: "trivia",
      interactiveExitDelayMs: 750,
      interactiveReadyPattern: "READY>",
      interactiveReadyFallbackDelayMs: 250,
    });

    const [cmd, args, opts] = mockSpawn.mock.calls[0];
    expect(cmd).toBe("expect");
    expect(args).toEqual([
      "-c",
      expect.stringContaining(
        'spawn claude --model $env(CC_PING_MODEL) --tools ""',
      ),
    ]);
    expect(args?.[1]).not.toContain(" -p ");
    expect(opts).toEqual(
      expect.objectContaining({
        cwd: tmpdir(),
        env: expect.objectContaining({
          CLAUDE_CONFIG_DIR: "/tmp/a",
          CC_PING_EXPECT_TIMEOUT_SECONDS: "30",
          CC_PING_INTERACTIVE_EXIT_DELAY_MS: "750",
          CC_PING_READY_PATTERN: "READY>",
          CC_PING_READY_FALLBACK_DELAY_MS: "250",
          CC_PING_PROMPT: expect.any(String),
          CC_PING_MODEL: "sonnet",
        }),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });

  it("reports interactive failures with distinct reasons", async () => {
    setupSpawnMock({
      code: 3,
      stdout: "CC_PING_FAILURE input_failed spawn id exp4 not open\n",
    });

    const results = await pingAccounts(
      [{ handle: "input", configDir: "/tmp/input" }],
      { mode: "experimental-interactive" },
    );

    expect(results[0].success).toBe(false);
    expect(results[0].failureReason).toBe("input_failed");
    expect(results[0].error).toBe("input failed: spawn id exp4 not open");
  });

  it("reports marker failures without detail text", async () => {
    setupSpawnMock({
      code: 1,
      stdout: "CC_PING_FAILURE input_failed\n",
    });

    const results = await pingAccounts(
      [{ handle: "input", configDir: "/tmp/input" }],
      { mode: "experimental-interactive" },
    );

    expect(results[0].success).toBe(false);
    expect(results[0].failureReason).toBe("input_failed");
    expect(results[0].error).toBe("input failed");
  });

  it("falls back when an interactive failure marker has an unknown reason", async () => {
    setupSpawnMock({
      code: 1,
      stdout: "CC_PING_FAILURE unknown_reason detail\n",
    });

    const results = await pingAccounts(
      [{ handle: "fail", configDir: "/tmp/fail" }],
      { mode: "experimental-interactive" },
    );

    expect(results[0].success).toBe(false);
    expect(results[0].failureReason).toBe("interactive_failed");
    expect(results[0].error).toBe(
      "interactive failed: CC_PING_FAILURE unknown_reason detail",
    );
  });

  it("reports unstructured expect timeout exits as response timeouts", async () => {
    setupSpawnMock({ code: 124, stdout: "" });

    const results = await pingAccounts(
      [{ handle: "timeout", configDir: "/tmp/timeout" }],
      { mode: "experimental-interactive" },
    );

    expect(results[0].success).toBe(false);
    expect(results[0].failureReason).toBe("response_timeout");
    expect(results[0].error).toBe("response timeout");
  });

  it("reports clean interactive exits without a success marker as failures", async () => {
    setupSpawnMock({ code: 0, stdout: "" });

    const results = await pingAccounts(
      [{ handle: "fail", configDir: "/tmp/fail" }],
      { mode: "experimental-interactive" },
    );

    expect(results[0].success).toBe(false);
    expect(results[0].failureReason).toBe("interactive_failed");
    expect(results[0].error).toBe("interactive failed: missing success marker");
  });

  it("reports unstructured authentication failures from interactive output", async () => {
    setupSpawnMock({
      code: 2,
      stderr: "Please login before using Claude Code\n",
    });

    const results = await pingAccounts(
      [{ handle: "login", configDir: "/tmp/login" }],
      { mode: "experimental-interactive" },
    );

    expect(results[0].success).toBe(false);
    expect(results[0].failureReason).toBe("not_authenticated");
    expect(results[0].error).toBe(
      "not authenticated: Claude requires login or authentication",
    );
  });

  it("captures stderr details for interactive failures", async () => {
    setupSpawnMock({
      code: 1,
      stderr: "Claude exited before showing a prompt\n",
    });

    const results = await pingAccounts(
      [{ handle: "fail", configDir: "/tmp/fail" }],
      { mode: "experimental-interactive" },
    );

    expect(results[0].success).toBe(false);
    expect(results[0].failureReason).toBe("interactive_failed");
    expect(results[0].error).toBe(
      "interactive failed: Claude exited before showing a prompt",
    );
  });

  it("keeps the tail of long interactive output for failure details", async () => {
    setupSpawnMock({
      code: 1,
      stdout: `${"x".repeat(9000)}\nfinal failure detail\n`,
    });

    const results = await pingAccounts(
      [{ handle: "fail", configDir: "/tmp/fail" }],
      { mode: "experimental-interactive" },
    );

    expect(results[0].success).toBe(false);
    expect(results[0].failureReason).toBe("interactive_failed");
    expect(results[0].error).toBe("interactive failed: final failure detail");
  });

  it("kills interactive pings that exceed the outer timeout", async () => {
    vi.useFakeTimers();
    setupSpawnMock({ delayMs: 60_000 });

    const promise = pingAccounts(
      [{ handle: "timeout", configDir: "/tmp/timeout" }],
      { mode: "experimental-interactive" },
    );
    await vi.advanceTimersByTimeAsync(36_000);
    const results = await promise;

    expect(results[0].success).toBe(false);
    expect(results[0].failureReason).toBe("response_timeout");
    expect(results[0].error).toBe("response timeout");
  });

  it("reports missing expect clearly", async () => {
    const err = Object.assign(new Error("spawn expect ENOENT"), {
      code: "ENOENT",
    });
    setupSpawnMock({ error: err });

    const results = await pingAccounts(
      [{ handle: "fail", configDir: "/tmp/fail" }],
      { mode: "experimental-interactive" },
    );

    expect(results[0].success).toBe(false);
    expect(results[0].failureReason).toBe("expect_missing");
    expect(results[0].error).toBe("expect not found");
  });

  it("reports non-ENOENT spawn errors as interactive failures", async () => {
    const err = Object.assign(new Error("spawn expect EACCES"), {
      code: "EACCES",
    });
    setupSpawnMock({ error: err });

    const results = await pingAccounts(
      [{ handle: "fail", configDir: "/tmp/fail" }],
      { mode: "experimental-interactive" },
    );

    expect(results[0].success).toBe(false);
    expect(results[0].failureReason).toBe("interactive_failed");
    expect(results[0].error).toBe("spawn expect EACCES");
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

  it("maps api_error_status 401 to an actionable auth hint", async () => {
    setupMock(null, apiErrorJson(401, "Failed to authenticate"));
    const results = await pingAccounts([
      { handle: "auth", configDir: "/tmp/auth" },
    ]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe("auth expired — run cc-ping login auth");
  });

  it("maps a logged-out result to the auth hint even without a 401 status", async () => {
    setupMock(
      new Error("Command failed: claude"),
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "s",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: true,
        api_error_status: null,
        num_turns: 1,
        result: "Not logged in · Please run /login",
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        model_usage: { "claude-sonnet-4-20250514": {} },
      }),
    );
    const results = await pingAccounts([
      { handle: "auth", configDir: "/tmp/auth" },
    ]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe("auth expired — run cc-ping login auth");
  });

  it("maps api_error_status 402 to a billing hint", async () => {
    setupMock(null, apiErrorJson(402));
    const results = await pingAccounts([{ handle: "a", configDir: "/tmp/a" }]);
    expect(results[0].error).toBe("billing issue");
  });

  it("maps api_error_status 403 to a permission hint", async () => {
    setupMock(null, apiErrorJson(403));
    const results = await pingAccounts([{ handle: "a", configDir: "/tmp/a" }]);
    expect(results[0].error).toBe("permission denied");
  });

  it("maps api_error_status 429 to rate limited", async () => {
    setupMock(null, apiErrorJson(429));
    const results = await pingAccounts([{ handle: "a", configDir: "/tmp/a" }]);
    expect(results[0].error).toBe("rate limited");
    expect(results[0].rateLimitResetAt).toBeUndefined();
  });

  it("enriches the rate-limited error with the reset time from the body", async () => {
    setupMock(
      null,
      apiErrorJson(
        429,
        "You've hit your weekly limit · resets 9pm (Europe/Stockholm)",
      ),
    );
    const results = await pingAccounts([{ handle: "a", configDir: "/tmp/a" }]);
    expect(results[0].error).toBe("weekly limit (resets 9pm)");
    expect(results[0].rateLimitResetAt).toBeInstanceOf(Date);
    expect(results[0].rateLimitResetAt!.getHours()).toBe(21);
  });

  it("reports a bare 'rate limited' when the 429 body has a reset but no limit type", async () => {
    setupMock(null, apiErrorJson(429, "resets 9pm"));
    const results = await pingAccounts([{ handle: "a", configDir: "/tmp/a" }]);
    expect(results[0].error).toBe("rate limited (resets 9pm)");
  });

  it("maps 5xx api_error_status to server error with code", async () => {
    setupMock(null, apiErrorJson(529));
    const results = await pingAccounts([{ handle: "a", configDir: "/tmp/a" }]);
    expect(results[0].error).toBe("server error (529)");
  });

  it("falls back to HTTP code for unmapped api_error_status", async () => {
    setupMock(null, apiErrorJson(418));
    const results = await pingAccounts([{ handle: "a", configDir: "/tmp/a" }]);
    expect(results[0].error).toBe("HTTP 418");
  });

  it("never reports literal subtype 'success' as the error label", async () => {
    setupMock(
      null,
      JSON.stringify({
        type: "result",
        subtype: "success",
        session_id: "s",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: true,
        num_turns: 1,
        result: "",
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        model_usage: { "claude-sonnet-4-20250514": {} },
      }),
    );
    const results = await pingAccounts([{ handle: "a", configDir: "/tmp/a" }]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).not.toBe("success");
    expect(results[0].error).toBeUndefined();
  });

  it("leaves error undefined when is_error has no subtype or status", async () => {
    setupMock(
      null,
      JSON.stringify({
        type: "result",
        subtype: "",
        session_id: "s",
        duration_ms: 1,
        duration_api_ms: 1,
        is_error: true,
        num_turns: 1,
        result: "",
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        model_usage: { "claude-sonnet-4-20250514": {} },
      }),
    );
    const results = await pingAccounts([{ handle: "a", configDir: "/tmp/a" }]);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBeUndefined();
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

describe("pingOne timeout enforcement", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves within timeout even when child process hangs", async () => {
    vi.useFakeTimers();

    // Simulate a child process where execFile callback never fires
    // (what happens when the process ignores SIGTERM and doesn't exit)
    const killFn = vi.fn();
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, _cb: unknown) => {
        return {
          stdin: { end: vi.fn() },
          pid: 99999,
          kill: killFn,
        } as unknown as ReturnType<typeof execFile>;
      },
    );

    const promise = pingAccounts([{ handle: "hung", configDir: "/tmp/hung" }]);

    // Advance past the hard kill timeout
    await vi.advanceTimersByTimeAsync(36_000);

    const results = await promise;
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe("timed out");
    expect(killFn).toHaveBeenCalledWith("SIGKILL");
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

  it("returns aborted for ABORT_ERR code", () => {
    const err = Object.assign(new Error("The operation was aborted"), {
      code: "ABORT_ERR",
      killed: true,
    });
    expect(formatExecError(err)).toBe("aborted");
  });
});
