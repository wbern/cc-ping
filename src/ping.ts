import { execFile } from "node:child_process";
import { parseClaudeResponse } from "./parse.js";
import { generatePrompt } from "./prompt.js";
import type { AccountConfig, PingResult } from "./types.js";

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
          if (isError && claudeResponse?.subtype) {
            errorMsg = claudeResponse.subtype;
          } else {
            errorMsg = formatExecError(error);
          }
        } else if (isError) {
          errorMsg = claudeResponse?.subtype;
        }

        resolve({
          handle: account.handle,
          success: !error && !isError,
          durationMs: Date.now() - start,
          error: errorMsg,
          claudeResponse,
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
