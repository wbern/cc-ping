import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import { filterAccounts } from "./filter-accounts.js";
import { readAccountIdentity } from "./identity.js";
import { clearAuthFailure } from "./state.js";
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

// Resolve which accounts to log in. With a handle, reuse filterAccounts (and its
// "Unknown account(s)" error) and return just that account. With no handle,
// return every configured account flagged as needing login (a 401 recorded in
// state), in config order; an empty set is an error telling the user to name a
// handle.
export function resolveLoginTargets(
  accounts: AccountConfig[],
  handle: string | undefined,
  needsLogin: string[],
): AccountConfig[] {
  if (handle) {
    return filterAccounts(accounts, [handle]);
  }

  const flagged = new Set(needsLogin);
  const targets = accounts.filter((a) => flagged.has(a.handle));
  if (targets.length === 0) {
    throw new Error(
      "No accounts flagged as needing login. Specify one: cc-ping login <handle>",
    );
  }
  return targets;
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

interface RunLoginsDeps {
  // Injected for tests; default to the real implementations / console sinks.
  loginAccount?: (account: AccountConfig) => Promise<LoginResult>;
  clearAuthFailure?: (handle: string) => void;
  log?: (message: string) => void;
  error?: (message: string) => void;
}

// Log in each target sequentially (one interactive OAuth flow at a time), in the
// order resolveLoginTargets returned them. When more than one account needs
// login we announce the batch up front and number each step. A successful login
// (exit 0) clears the account's recorded auth failure; a non-zero exit or a
// spawn error counts toward the returned failure total without aborting the
// remaining logins. Returns the number of accounts that failed to log in.
export async function runLogins(
  targets: AccountConfig[],
  deps: RunLoginsDeps = {},
): Promise<number> {
  const doLogin = deps.loginAccount ?? loginAccount;
  const doClear = deps.clearAuthFailure ?? clearAuthFailure;
  const log = deps.log ?? ((m: string) => console.log(m));
  const error = deps.error ?? ((m: string) => console.error(m));

  if (targets.length > 1) {
    log(
      `${targets.length} account(s) need login: ${targets
        .map((t) => t.handle)
        .join(", ")}`,
    );
  }

  let failed = 0;
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const prefix = targets.length > 1 ? `[${i + 1}/${targets.length}] ` : "";
    log(`${prefix}Logging in: ${target.handle} -> ${target.configDir}`);
    try {
      const result = await doLogin(target);
      if (result.exitCode === 0) {
        doClear(target.handle);
      } else {
        failed++;
      }
    } catch (err) {
      error(`  ${target.handle}: ${(err as Error).message}`);
      failed++;
    }
  }
  return failed;
}
