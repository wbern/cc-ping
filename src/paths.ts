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

/**
 * Returns the executable and prefix args needed to re-invoke this process.
 * In Node: [process.execPath, scriptPath]
 * In a compiled binary (Bun compile): [process.execPath] (no script arg)
 */
export function selfArgs(): [string, ...string[]] {
  if (process.argv[1]?.endsWith(".js")) {
    return [process.execPath, process.argv[1]];
  }
  return [process.execPath];
}
