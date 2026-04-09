import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountConfig } from "./types.js";

export function scanAccounts(dir?: string): AccountConfig[] {
  const accountsDir = dir ?? homedir();
  if (!existsSync(accountsDir)) return [];

  return readdirSync(accountsDir)
    .filter((name) => {
      const full = join(accountsDir, name);
      return (
        statSync(full).isDirectory() &&
        !name.startsWith(".") &&
        existsSync(join(full, ".claude.json"))
      );
    })
    .map((name) => ({
      handle: name,
      configDir: join(accountsDir, name),
    }));
}
