import { homedir } from "node:os";
import { join } from "node:path";

let configDirOverride: string | undefined;

export function setConfigDir(dir: string): void {
  configDirOverride = dir;
}

export function resolveConfigDir(): string {
  if (configDirOverride) return configDirOverride;
  if (process.env.CC_PING_CONFIG) return process.env.CC_PING_CONFIG;
  return join(homedir(), ".config", "cc-ping");
}
