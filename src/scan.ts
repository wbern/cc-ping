import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountConfig } from "./types.js";

const ACCOUNTS_DIR = join(homedir(), ".claude-accounts");

export function scanAccounts(): AccountConfig[] {
  if (!existsSync(ACCOUNTS_DIR)) return [];

  return readdirSync(ACCOUNTS_DIR)
    .filter((name) => {
      const full = join(ACCOUNTS_DIR, name);
      return statSync(full).isDirectory() && !name.startsWith(".");
    })
    .map((name) => ({
      handle: name,
      configDir: join(ACCOUNTS_DIR, name),
    }));
}
