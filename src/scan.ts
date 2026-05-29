import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountConfig } from "./types.js";

// macOS TCC-protected and cloud-sync folder names. Touching any of these during
// a home-directory walk triggers a system permission prompt ("cc-ping wants to
// access files managed by Google Drive") and can be slow on network mounts.
// Account directories are identified by a contained .claude.json and never use
// these names, so skipping them by name — before any statSync/existsSync call —
// avoids the prompts entirely. Matched case-insensitively.
const SKIP_DIRS = new Set([
  "desktop",
  "documents",
  "downloads",
  "pictures",
  "movies",
  "music",
  "public",
  "library",
  "applications",
  "google drive",
  "googledrive",
  "dropbox",
  "onedrive",
  "icloud drive",
  "creative cloud files",
]);

export function scanAccounts(dir?: string): AccountConfig[] {
  const accountsDir = dir ?? homedir();
  if (!existsSync(accountsDir)) return [];

  return readdirSync(accountsDir)
    .filter((name) => {
      if (name.startsWith(".") || SKIP_DIRS.has(name.toLowerCase())) {
        return false;
      }
      const full = join(accountsDir, name);
      return (
        statSync(full).isDirectory() && existsSync(join(full, ".claude.json"))
      );
    })
    .map((name) => ({
      handle: name,
      configDir: join(accountsDir, name),
    }));
}
