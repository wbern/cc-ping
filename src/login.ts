import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import { checkAccount } from "./check.js";
import { filterAccounts } from "./filter-accounts.js";
import { readAccountIdentity } from "./identity.js";
import type { AccountConfig } from "./types.js";

interface LoginDeps {
  // Injected for tests; defaults to node's child_process.spawn.
  spawn?: (
    command: string,
    args: string[],
    options: {
      stdio: "inherit";
      cwd: string;
      env: NodeJS.ProcessEnv;
    },
  ) => ChildProcess;
}

interface LoginResult {
  handle: string;
  configDir: string;
  exitCode: number;
}

// Resolve which account to log in. With a handle, reuse filterAccounts (and its
// "Unknown account(s)" error). With no handle, auto-pick the single account that
// has no stored credentials; ambiguity or absence is an error telling the user
// to name a handle.
export function resolveLoginTarget(
  accounts: AccountConfig[],
  handle: string | undefined,
): AccountConfig {
  if (handle) {
    return filterAccounts(accounts, [handle])[0];
  }

  const unauthenticated = accounts.filter((a) => !checkAccount(a).healthy);
  if (unauthenticated.length === 1) {
    return unauthenticated[0];
  }
  if (unauthenticated.length === 0) {
    throw new Error(
      "No unauthenticated accounts found. Specify one: cc-ping login <handle>",
    );
  }
  throw new Error(
    `Multiple unauthenticated accounts (${unauthenticated
      .map((a) => a.handle)
      .join(", ")}). Specify one: cc-ping login <handle>`,
  );
}

// Run the official `claude auth login` OAuth flow scoped to the account's
// CLAUDE_CONFIG_DIR. stdio is inherited so the browser/device flow is fully
// interactive with NO timeout (unlike pingOne). cwd is a neutral temp dir to
// avoid attributing project-context reads to cc-ping (see ping.ts). Credentials
// are isolated per config dir (verified: claude auth status reads back the
// correct account per CLAUDE_CONFIG_DIR), so this never clobbers another
// account's session.
export function loginAccount(
  account: AccountConfig,
  deps: LoginDeps = {},
): Promise<LoginResult> {
  const spawn = deps.spawn ?? nodeSpawn;

  const args = ["auth", "login"];
  const identity = readAccountIdentity(account.configDir);
  if (identity) {
    args.push("--email", identity.email);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      stdio: "inherit",
      cwd: tmpdir(),
      env: { ...process.env, CLAUDE_CONFIG_DIR: account.configDir },
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        handle: account.handle,
        configDir: account.configDir,
        exitCode: code ?? 0,
      });
    });
  });
}
