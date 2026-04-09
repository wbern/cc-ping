import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigDir } from "./paths.js";
import type { AccountConfig, Config } from "./types.js";

export function loadConfig(): Config {
  const configFile = join(resolveConfigDir(), "config.json");
  if (!existsSync(configFile)) {
    return { accounts: [] };
  }
  try {
    const raw = readFileSync(configFile, "utf-8");
    return JSON.parse(raw) as Config;
  } catch {
    return { accounts: [] };
  }
}

export function saveConfig(config: Config): void {
  const configDir = resolveConfigDir();
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "config.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

export function addAccount(
  handle: string,
  configDir: string,
  group?: string,
): void {
  const config = loadConfig();
  const existing = config.accounts.findIndex((a) => a.handle === handle);
  if (existing !== -1) {
    config.accounts[existing].configDir = configDir;
    config.accounts[existing].group = group;
  } else {
    const account: AccountConfig = { handle, configDir };
    if (group) account.group = group;
    config.accounts.push(account);
  }
  saveConfig(config);
}

export function removeAccount(handle: string): boolean {
  const config = loadConfig();
  const before = config.accounts.length;
  config.accounts = config.accounts.filter((a) => a.handle !== handle);
  if (config.accounts.length === before) return false;
  saveConfig(config);
  return true;
}

export function listAccounts(): AccountConfig[] {
  return loadConfig().accounts;
}

export function resetSchedule(
  handle?: string,
  now: Date = new Date(),
): boolean {
  const config = loadConfig();
  if (handle) {
    const account = config.accounts.find((a) => a.handle === handle);
    if (!account) return false;
    account.scheduleResetAt = now.toISOString();
  } else {
    if (config.accounts.length === 0) return false;
    for (const account of config.accounts) {
      account.scheduleResetAt = now.toISOString();
    }
  }
  saveConfig(config);
  return true;
}
