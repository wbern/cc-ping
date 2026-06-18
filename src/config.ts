import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfigDir } from "./paths.js";
import { clearPingState } from "./state.js";
import type {
  AccountConfig,
  Config,
  PingMode,
  PromptStyle,
  RemoteNotifyConfig,
  Settings,
} from "./types.js";

const DEFAULT_PING_MODE: PingMode = "print";
const DEFAULT_INTERACTIVE_EXIT_DELAY_MS = 2500;
const DEFAULT_INTERACTIVE_READY_PATTERN = "(\\u276f|>|›)[ \\u00a0]*";
const DEFAULT_INTERACTIVE_READY_FALLBACK_DELAY_MS = 5000;
const DEFAULT_PROMPT_STYLE: PromptStyle = "mixed";
const DEFAULT_MODEL = "haiku";

type SettingsKey = keyof Settings;

function normalizePingMode(value: Settings["pingMode"]): PingMode {
  if (value === "experimental-interactive" || value === "interactive") {
    return "experimental-interactive";
  }
  return "print";
}

function validPromptStyle(value: unknown): value is PromptStyle {
  return (
    value === "mixed" ||
    value === "math" ||
    value === "trivia" ||
    value === "tiny-chat" ||
    value === "chess"
  );
}

export function resolveSettings(
  config: Config = loadConfig(),
): Required<Settings> {
  const settings = config.settings ?? {};
  return {
    pingMode: normalizePingMode(settings.pingMode ?? DEFAULT_PING_MODE),
    interactiveExitDelayMs:
      typeof settings.interactiveExitDelayMs === "number" &&
      Number.isFinite(settings.interactiveExitDelayMs) &&
      settings.interactiveExitDelayMs >= 0
        ? settings.interactiveExitDelayMs
        : DEFAULT_INTERACTIVE_EXIT_DELAY_MS,
    interactiveReadyPattern:
      typeof settings.interactiveReadyPattern === "string" &&
      settings.interactiveReadyPattern.trim() !== ""
        ? settings.interactiveReadyPattern
        : DEFAULT_INTERACTIVE_READY_PATTERN,
    interactiveReadyFallbackDelayMs:
      typeof settings.interactiveReadyFallbackDelayMs === "number" &&
      Number.isFinite(settings.interactiveReadyFallbackDelayMs) &&
      settings.interactiveReadyFallbackDelayMs >= 0
        ? settings.interactiveReadyFallbackDelayMs
        : DEFAULT_INTERACTIVE_READY_FALLBACK_DELAY_MS,
    promptStyle: validPromptStyle(settings.promptStyle)
      ? settings.promptStyle
      : DEFAULT_PROMPT_STYLE,
    model:
      typeof settings.model === "string" && settings.model.trim() !== ""
        ? settings.model
        : DEFAULT_MODEL,
  };
}

function isSettingsKey(key: string): key is SettingsKey {
  return (
    key === "pingMode" ||
    key === "interactiveExitDelayMs" ||
    key === "interactiveReadyPattern" ||
    key === "interactiveReadyFallbackDelayMs" ||
    key === "promptStyle" ||
    key === "model"
  );
}

function parseSettingValue(
  key: SettingsKey,
  value: string,
): Settings[SettingsKey] {
  switch (key) {
    case "pingMode":
      if (value === "print" || value === "experimental-interactive") {
        return value;
      }
      if (value === "legacy-print") return "print";
      if (value === "interactive") return "experimental-interactive";
      throw new Error("pingMode must be 'print' or 'experimental-interactive'");
    case "interactiveExitDelayMs":
    case "interactiveReadyFallbackDelayMs": {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
      throw new Error(`${key} must be a non-negative number`);
    }
    case "interactiveReadyPattern":
      if (value.trim() !== "") return value;
      throw new Error("interactiveReadyPattern must not be empty");
    case "promptStyle":
      if (validPromptStyle(value)) return value;
      throw new Error(
        "promptStyle must be 'mixed', 'math', 'trivia', 'tiny-chat', or 'chess'",
      );
    case "model":
      if (value.trim() !== "") return value;
      throw new Error("model must not be empty");
  }
}

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

export function setSetting(key: string, value: string): Required<Settings> {
  if (!isSettingsKey(key)) {
    throw new Error(`Unsupported setting: ${key}`);
  }
  const config = loadConfig();
  config.settings = {
    ...config.settings,
    [key]: parseSettingValue(key, value),
  };
  saveConfig(config);
  return resolveSettings(config);
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
