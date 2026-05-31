import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigDir } from "./paths.js";
import { clearPingState } from "./state.js";
import type { AccountConfig, Config, RemoteNotifyConfig } from "./types.js";

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
  clearPingState(handle);
  return true;
}

export function listAccounts(): AccountConfig[] {
  return loadConfig().accounts;
}

export function getRemoteNotify(): RemoteNotifyConfig | undefined {
  return loadConfig().remoteNotify;
}

export function setRemoteNotifyUrl(url: string): void {
  const config = loadConfig();
  config.remoteNotify = { ...config.remoteNotify, url };
  saveConfig(config);
}

export function clearRemoteNotify(): boolean {
  const config = loadConfig();
  if (!config.remoteNotify) return false;
  config.remoteNotify = undefined;
  saveConfig(config);
  return true;
}

export function getNotifyCommand(): string[] | undefined {
  return loadConfig().notifyCommand;
}

export function setNotifyCommand(command: string[]): void {
  const config = loadConfig();
  config.notifyCommand = command;
  saveConfig(config);
}

export function clearNotifyCommand(): boolean {
  const config = loadConfig();
  if (!config.notifyCommand) return false;
  config.notifyCommand = undefined;
  saveConfig(config);
  return true;
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
