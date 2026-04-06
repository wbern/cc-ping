import { execFile } from "node:child_process";
import type { AccountConfig, PingResult } from "./types.js";

function pingOne(account: AccountConfig): Promise<PingResult> {
  const start = Date.now();

  return new Promise((resolve) => {
    const child = execFile(
      "claude",
      ["-p", "ping", "--output-format", "text"],
      {
        env: { ...process.env, CLAUDE_CONFIG_DIR: account.configDir },
        timeout: 30_000,
      },
      (error) => {
        resolve({
          handle: account.handle,
          success: !error,
          durationMs: Date.now() - start,
          error: error?.message,
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
