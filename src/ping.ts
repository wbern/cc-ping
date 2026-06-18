import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { parseClaudeResponse } from "./parse.js";
import { generatePrompt } from "./prompt.js";
import { parseRateLimitReset } from "./rate-limit.js";
import type {
  AccountConfig,
  ClaudeJsonResponse,
  PingFailureReason,
  PingMode,
  PingResult,
  PromptStyle,
} from "./types.js";

// A logged-out or expired session does not come back as an HTTP 401. Claude
// reports it as a successful-shaped result with is_error set and a result body
// like "Not logged in · Please run /login" (api_error_status is null).
export function isAuthError(response: ClaudeJsonResponse): boolean {
  if (response.api_error_status === 401) return true;
  return (
    response.is_error &&
    /not logged in|please run \/login/i.test(response.result)
  );
}

function describeClaudeError(
  response: ClaudeJsonResponse,
  handle: string,
): string | undefined {
  const status = response.api_error_status;
  if (isAuthError(response)) {
    return `auth expired — run cc-ping login ${handle}`;
  }
  if (status !== undefined) {
    if (status === 402) return "billing issue";
    if (status === 403) return "permission denied";
    if (status === 429) {
      const info = parseRateLimitReset(response.result, new Date());
      if (!info) return "rate limited";
      // Name the limit type when the body states it ("weekly limit", "5-hour
      // limit") so the log answers "what kind of limit" at a glance.
      const kind = info.scope ? `${info.scope} limit` : "rate limited";
      return `${kind} (resets ${info.resetLabel})`;
    }
    if (status >= 500) return `server error (${status})`;
    return `HTTP ${status}`;
  }
  const subtype = response.subtype;
  return subtype && subtype !== "success" ? subtype : undefined;
}

export function formatExecError(error: Error): string {
  if ((error as NodeJS.ErrnoException).code === "ABORT_ERR") {
    return "aborted";
  }
  if ("killed" in error && (error as { killed: boolean }).killed) {
    return "timed out";
  }
  const msg = error.message;
  if (msg.startsWith("Command failed:")) {
    return "command failed";
  }
  return msg;
}

const PING_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 5_000;
const EXPECT_TIMEOUT_SECONDS = Math.ceil(PING_TIMEOUT_MS / 1000);
const OUTPUT_TAIL_LIMIT = 8192;
// biome-ignore lint/complexity/useRegexLiterals: A literal trips noControlCharactersInRegex for ESC.
const ANSI_ESCAPE_PATTERN = new RegExp("\\u001b\\[[0-?]*[ -/]*[@-~]", "g");
const FAILURE_MARKER = "CC_PING_FAILURE";
const SUCCESS_MARKER = "CC_PING_SUCCESS";
const AUTH_REQUIRED_PATTERN =
  "(not authenticated|authentication required|please log in|please login|login required|invalid api key)";

const INTERACTIVE_CLAUDE_EXPECT_SCRIPT = `
set timeout $env(CC_PING_EXPECT_TIMEOUT_SECONDS)
set ready_re $env(CC_PING_READY_PATTERN)
log_user 0

if {[catch {spawn claude --model $env(CC_PING_MODEL) --tools ""} spawn_error]} {
  if {[regexp -nocase {(no such file|not found)} $spawn_error]} {
    puts "CC_PING_FAILURE claude_missing $spawn_error"
    exit 127
  }
  puts "CC_PING_FAILURE claude_spawn_failed $spawn_error"
  exit 1
}

expect {
  -re $ready_re {}
  -nocase -re {${AUTH_REQUIRED_PATTERN}} {
    puts "CC_PING_FAILURE not_authenticated Claude requires login or authentication"
    exit 2
  }
  timeout {
    if {$env(CC_PING_READY_FALLBACK_DELAY_MS) > 0} {
      after $env(CC_PING_READY_FALLBACK_DELAY_MS)
    } else {
      puts "CC_PING_FAILURE startup_prompt_timeout timeout waiting for Claude prompt"
      exit 124
    }
  }
  eof {
    puts "CC_PING_FAILURE claude_spawn_failed Claude exited before showing a prompt"
    exit 1
  }
}

if {[catch {
  send -- $env(CC_PING_PROMPT)
  send -- "\\r"
} send_error]} {
  puts "CC_PING_FAILURE input_failed $send_error"
  exit 3
}

expect {
  -re $ready_re {
    after $env(CC_PING_INTERACTIVE_EXIT_DELAY_MS)
    if {[catch {send -- "\\004"} exit_error]} {
      puts "CC_PING_FAILURE session_exit_failed $exit_error"
      exit 4
    }
    puts "CC_PING_SUCCESS prompt_completed"
    exit 0
  }
  -nocase -re {${AUTH_REQUIRED_PATTERN}} {
    puts "CC_PING_FAILURE not_authenticated Claude requires login or authentication"
    exit 2
  }
  timeout {
    puts "CC_PING_FAILURE response_timeout timeout waiting for Claude response"
    exit 124
  }
  eof {
    puts "CC_PING_FAILURE response_timeout Claude exited before the response completed"
    exit 1
  }
}
`.trim();

interface PingOptions {
  parallel?: boolean;
  signal?: AbortSignal;
  mode?: PingMode | "legacy-print" | "interactive";
  model?: string;
  promptStyle?: PromptStyle;
  interactiveExitDelayMs?: number;
  interactiveReadyPattern?: string;
  interactiveReadyFallbackDelayMs?: number;
}

interface PingFailure {
  reason: PingFailureReason;
  error: string;
}

function normalizeMode(mode: PingOptions["mode"]): PingMode {
  if (mode === "experimental-interactive" || mode === "interactive") {
    return "experimental-interactive";
  }
  return "print";
}

function appendOutputTail(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  if (next.length <= OUTPUT_TAIL_LIMIT) return next;
  return next.slice(-OUTPUT_TAIL_LIMIT);
}

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function lastMeaningfulLine(output: string): string | undefined {
  return stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
}

function formatFailureReason(reason: PingFailureReason): string {
  return reason.replaceAll("_", " ");
}

function hasSuccessMarker(output: string): boolean {
  return stripAnsi(output)
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .includes(`${SUCCESS_MARKER} prompt_completed`);
}

function isPingFailureReason(value: string): value is PingFailureReason {
  return [
    "expect_missing",
    "claude_missing",
    "claude_spawn_failed",
    "not_authenticated",
    "startup_prompt_timeout",
    "input_failed",
    "response_timeout",
    "session_exit_failed",
    "interactive_failed",
    "legacy_command_failed",
    "legacy_json_parse_failed",
    "legacy_claude_error",
    "rate_limited",
  ].includes(value);
}

function markerFailure(output: string): PingFailure | undefined {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const line = [...lines]
    .reverse()
    .find((entry) => entry.startsWith(`${FAILURE_MARKER} `));
  if (!line) return undefined;

  const [, reason, ...detailParts] = line.split(/\s+/);
  if (!isPingFailureReason(reason)) return undefined;

  const detail = detailParts.join(" ").trim();
  return {
    reason,
    error: detail
      ? `${formatFailureReason(reason)}: ${detail}`
      : formatFailureReason(reason),
  };
}

function authFailure(output: string): PingFailure | undefined {
  if (
    /(not authenticated|authentication required|please log in|please login|login required|invalid api key)/i.test(
      stripAnsi(output),
    )
  ) {
    return {
      reason: "not_authenticated",
      error: "not authenticated: Claude requires login or authentication",
    };
  }
  return undefined;
}

function formatInteractiveFailure(
  code: number | null,
  signal: NodeJS.Signals | null,
  output: string,
): PingFailure {
  const marker = markerFailure(output);
  if (marker) return marker;
  const auth = authFailure(output);
  if (auth) return auth;
  if (code === 0) {
    return {
      reason: "interactive_failed",
      error: "interactive failed: missing success marker",
    };
  }
  if (code === 124 || signal) {
    return { reason: "response_timeout", error: "response timeout" };
  }
  const detail = lastMeaningfulLine(output);
  return {
    reason: "interactive_failed",
    error: detail ? `interactive failed: ${detail}` : "interactive ping failed",
  };
}

function formatSpawnError(error: Error): PingFailure {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") {
    return { reason: "expect_missing", error: "expect not found" };
  }
  return { reason: "interactive_failed", error: formatExecError(error) };
}

function pingOne(
  account: AccountConfig,
  options: PingOptions,
): Promise<PingResult> {
  const start = Date.now();
  const prompt = generatePrompt(options.promptStyle);
  const model = options.model ?? "haiku";

  return new Promise((resolve) => {
    let resolved = false;

    const child = execFile(
      "claude",
      [
        "-p",
        prompt,
        "--model",
        model,
        "--output-format",
        "json",
        "--no-session-persistence",
        "--tools",
        "",
        "--max-turns",
        "1",
      ],
      {
        // Run from a neutral temp dir, NOT the inherited cwd. Claude Code reads
        // project/context files from its working directory on startup; if cc-ping
        // (or the daemon) was launched from ~ or a synced/protected tree, that
        // enumeration is attributed by macOS TCC to the parent ("cc-ping wants
        // to access Google Drive") and recurs every ping. tmpdir has no project
        // context and is never TCC-protected.
        cwd: tmpdir(),
        env: { ...process.env, CLAUDE_CONFIG_DIR: account.configDir },
        timeout: PING_TIMEOUT_MS,
        killSignal: "SIGKILL",
        signal: options.signal,
      },
      (error, stdout) => {
        /* c8 ignore next -- guard against hard-kill race */
        if (resolved) return;
        resolved = true;
        clearTimeout(hardKillTimer);

        const claudeResponse = parseClaudeResponse(stdout) ?? undefined;
        const isError = claudeResponse?.is_error === true;

        let errorMsg: string | undefined;
        if (error) {
          // Prefer claudeResponse subtype (e.g. "error_max_turns") over raw execFile message
          if (isError && claudeResponse) {
            errorMsg = describeClaudeError(claudeResponse, account.handle);
          } else {
            errorMsg = formatExecError(error);
          }
        } else if (isError && claudeResponse) {
          errorMsg = describeClaudeError(claudeResponse, account.handle);
        }

        // Surface the reset instant separately so the daemon can schedule its
        // next attempt for when the limit actually lifts.
        const rateLimitResetAt =
          claudeResponse?.api_error_status === 429
            ? parseRateLimitReset(claudeResponse.result, new Date())?.resetAt
            : undefined;

        resolve({
          handle: account.handle,
          success: !error && !isError,
          durationMs: Date.now() - start,
          failureReason: error
            ? "legacy_command_failed"
            : isError
              ? claudeResponse?.api_error_status === 429
                ? "rate_limited"
                : "legacy_claude_error"
              : undefined,
          error: errorMsg,
          claudeResponse,
          rateLimitResetAt,
        });
      },
    );

    // Hard kill: if callback hasn't fired after timeout + grace, force-resolve
    const hardKillTimer = setTimeout(() => {
      /* c8 ignore next -- race-condition guard */
      if (resolved) return;
      resolved = true;
      child.kill("SIGKILL");
      resolve({
        handle: account.handle,
        success: false,
        durationMs: Date.now() - start,
        error: "timed out",
      });
    }, PING_TIMEOUT_MS + KILL_GRACE_MS);
    hardKillTimer.unref();

    // Ensure child doesn't hang
    child.stdin?.end();
  });
}

function pingInteractive(
  account: AccountConfig,
  options: Required<
    Pick<
      PingOptions,
      | "model"
      | "promptStyle"
      | "interactiveExitDelayMs"
      | "interactiveReadyPattern"
      | "interactiveReadyFallbackDelayMs"
    >
  > &
    Pick<PingOptions, "signal">,
): Promise<PingResult> {
  const start = Date.now();
  const prompt = generatePrompt(options.promptStyle);

  return new Promise((resolve) => {
    let settled = false;
    let outputTail = "";
    let killTimer: NodeJS.Timeout | undefined;

    const finish = (success: boolean, failure?: PingFailure) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      resolve({
        handle: account.handle,
        success,
        durationMs: Date.now() - start,
        failureReason: failure?.reason,
        error: failure?.error,
      });
    };

    const child = spawn("expect", ["-c", INTERACTIVE_CLAUDE_EXPECT_SCRIPT], {
      cwd: tmpdir(),
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: account.configDir,
        CC_PING_EXPECT_TIMEOUT_SECONDS: String(EXPECT_TIMEOUT_SECONDS),
        CC_PING_INTERACTIVE_EXIT_DELAY_MS: String(
          options.interactiveExitDelayMs,
        ),
        CC_PING_READY_PATTERN: options.interactiveReadyPattern,
        CC_PING_READY_FALLBACK_DELAY_MS: String(
          options.interactiveReadyFallbackDelayMs,
        ),
        CC_PING_PROMPT: prompt,
        CC_PING_MODEL: options.model,
      },
      stdio: ["ignore", "pipe", "pipe"],
      signal: options.signal,
    });

    child.stdout?.on("data", (chunk) => {
      outputTail = appendOutputTail(outputTail, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      outputTail = appendOutputTail(outputTail, chunk);
    });
    child.on("error", (error) => finish(false, formatSpawnError(error)));
    child.on("close", (code, signal) => {
      if (hasSuccessMarker(outputTail)) {
        finish(true);
        return;
      }
      finish(false, formatInteractiveFailure(code, signal, outputTail));
    });

    killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false, { reason: "response_timeout", error: "response timeout" });
    }, PING_TIMEOUT_MS + KILL_GRACE_MS);
    killTimer.unref();
  });
}

export async function pingAccounts(
  accounts: AccountConfig[],
  options: PingOptions = {},
): Promise<PingResult[]> {
  const mode = normalizeMode(options.mode);
  const runOne = (account: AccountConfig) =>
    mode === "experimental-interactive"
      ? pingInteractive(account, {
          signal: options.signal,
          model: options.model ?? "haiku",
          promptStyle: options.promptStyle ?? "mixed",
          interactiveExitDelayMs: options.interactiveExitDelayMs ?? 2500,
          interactiveReadyPattern:
            options.interactiveReadyPattern ?? "(\\u276f|>|›)[ \\u00a0]*",
          interactiveReadyFallbackDelayMs:
            options.interactiveReadyFallbackDelayMs ?? 5000,
        })
      : pingOne(account, options);
  if (options.parallel) {
    return Promise.all(accounts.map(runOne));
  }
  const results: PingResult[] = [];
  for (const account of accounts) {
    results.push(await runOne(account));
  }
  return results;
}
