import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountConfig } from "./types.js";

// macOS TCC-protected and cloud-sync folder names. Touching any of these during
// the default home-directory walk triggers a system permission prompt ("cc-ping
// wants to access files managed by Google Drive") and can be slow on network
// mounts. Account directories are identified by a contained .claude.json and
// never use these names, so skipping them by name — before any statSync call —
// avoids the prompts entirely. Matched case-insensitively, and only applied to
// the default ~ scan: an explicitly chosen directory is searched verbatim.
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
  const applyDefaults = dir === undefined;
  if (!existsSync(accountsDir)) return [];

  return readdirSync(accountsDir)
    .filter((name) => {
      if (
        name.startsWith(".") ||
        (applyDefaults && SKIP_DIRS.has(name.toLowerCase()))
      ) {
        return false;
      }
      const full = join(accountsDir, name);
      // Entries in ~ can be dangling symlinks, sockets, or permission-denied; a
      // throwing stat must not abort the entire scan.
      try {
        return (
          statSync(full).isDirectory() && existsSync(join(full, ".claude.json"))
        );
      } catch {
        return false;
      }
    })
    .map((name) => ({
      handle: name,
      configDir: join(accountsDir, name),
    }));
}
