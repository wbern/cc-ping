import { execFile } from "node:child_process";
import { parseClaudeResponse } from "./parse.js";
import type { AccountConfig, PingResult } from "./types.js";

export function formatExecError(error: Error): string {
  if ("killed" in error && (error as { killed: boolean }).killed) {
    return "timed out";
  }
  const msg = error.message;
  if (msg.startsWith("Command failed:")) {
    return "command failed";
  }
  return msg;
}

function pingOne(account: AccountConfig): Promise<PingResult> {
  const start = Date.now();

  return new Promise((resolve) => {
    const child = execFile(
      "claude",
      ["-p", "ping", "--output-format", "json", "--tools", ""],
      {
        env: { ...process.env, CLAUDE_CONFIG_DIR: account.configDir },
        timeout: 30_000,
      },
      (error, stdout) => {
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

    // Ensure child doesn't hang
    child.stdin?.end();
  });
}

export async function pingAccounts(
  accounts: AccountConfig[],
  options: { parallel?: boolean } = {},
): Promise<PingResult[]> {
  if (options.parallel) {
    return Promise.all(accounts.map(pingOne));
  }
  const results: PingResult[] = [];
  for (const account of accounts) {
    results.push(await pingOne(account));
  }
  return results;
}
