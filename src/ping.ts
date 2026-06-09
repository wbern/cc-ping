import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { parseClaudeResponse } from "./parse.js";
import { generatePrompt } from "./prompt.js";
import { parseRateLimitReset } from "./rate-limit.js";
import type { AccountConfig, ClaudeJsonResponse, PingResult } from "./types.js";

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
      return info ? `rate limited (resets ${info.resetLabel})` : "rate limited";
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

function pingOne(
  account: AccountConfig,
  signal?: AbortSignal,
): Promise<PingResult> {
  const start = Date.now();

  return new Promise((resolve) => {
    let resolved = false;

    const child = execFile(
      "claude",
      [
        "-p",
        generatePrompt(),
        "--output-format",
        "json",
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
        signal,
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

export async function pingAccounts(
  accounts: AccountConfig[],
  options: { parallel?: boolean; signal?: AbortSignal } = {},
): Promise<PingResult[]> {
  if (options.parallel) {
    return Promise.all(accounts.map((a) => pingOne(a, options.signal)));
  }
  const results: PingResult[] = [];
  for (const account of accounts) {
    results.push(await pingOne(account, options.signal));
  }
  return results;
}
