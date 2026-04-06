import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AccountConfig } from "./types.js";

interface CheckResult {
  handle: string;
  configDir: string;
  healthy: boolean;
  issues: string[];
}

export function checkAccount(account: AccountConfig): CheckResult {
  const issues: string[] = [];

  if (
    !existsSync(account.configDir) ||
    !statSync(account.configDir).isDirectory()
  ) {
    issues.push("config directory does not exist");
    return {
      handle: account.handle,
      configDir: account.configDir,
      healthy: false,
      issues,
    };
  }

  const claudeJson = join(account.configDir, ".claude.json");
  if (!existsSync(claudeJson)) {
    issues.push(".claude.json not found");
    return {
      handle: account.handle,
      configDir: account.configDir,
      healthy: false,
      issues,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    const raw = readFileSync(claudeJson, "utf-8");
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    issues.push(".claude.json is not valid JSON");
    return {
      handle: account.handle,
      configDir: account.configDir,
      healthy: false,
      issues,
    };
  }

  if (!parsed.oauthAccount) {
    issues.push("no OAuth credentials found");
  }

  return {
    handle: account.handle,
    configDir: account.configDir,
    healthy: issues.length === 0,
    issues,
  };
}

export function checkAccounts(accounts: AccountConfig[]): CheckResult[] {
  return accounts.map((a) => checkAccount(a));
}
