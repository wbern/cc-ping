import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, Config } from "./types.js";

const CONFIG_DIR = join(homedir(), ".config", "cc-ping");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    return { accounts: [] };
  }
  const raw = readFileSync(CONFIG_FILE, "utf-8");
  return JSON.parse(raw) as Config;
}

export function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);
}

export function addAccount(handle: string, configDir: string): void {
  const config = loadConfig();
  const existing = config.accounts.findIndex((a) => a.handle === handle);
  if (existing !== -1) {
    config.accounts[existing].configDir = configDir;
  } else {
    config.accounts.push({ handle, configDir });
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
