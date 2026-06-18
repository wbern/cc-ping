import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountConfig, Config } from "./types.js";

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

type ScanCandidateStatus = "existing" | "new" | "missing";

interface ScanCandidate {
  account: AccountConfig;
  status: ScanCandidateStatus;
  selected: boolean;
}

export function buildScanCandidates(
  configured: AccountConfig[],
  discovered: AccountConfig[],
): ScanCandidate[] {
  const candidates: ScanCandidate[] = configured.map((account) => {
    const found = discovered.some((entry) => entry.handle === account.handle);
    return {
      account,
      status: found ? "existing" : "missing",
      selected: true,
    };
  });
  const configuredHandles = new Set(
    configured.map((account) => account.handle),
  );
  for (const account of discovered) {
    if (!configuredHandles.has(account.handle)) {
      candidates.push({ account, status: "new", selected: false });
    }
  }
  return candidates;
}

function assertSelectionInRange(value: number, candidates: ScanCandidate[]) {
  if (value < 1 || value > candidates.length) {
    throw new Error(`Selection out of range: ${value}`);
  }
}

export function parseScanSelection(
  input: string,
  candidates: ScanCandidate[],
): number[] {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === "") {
    return candidates
      .map((candidate, index) => (candidate.selected ? index : -1))
      .filter((index) => index !== -1);
  }
  if (trimmed === "all") return candidates.map((_, index) => index);
  if (trimmed === "none") return [];

  const selected = new Set<number>();
  for (const part of trimmed.split(",")) {
    const token = part.trim();
    if (token === "") continue;

    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (start > end) throw new Error(`Invalid selection range: ${token}`);
      for (let value = start; value <= end; value++) {
        assertSelectionInRange(value, candidates);
        selected.add(value - 1);
      }
      continue;
    }

    if (!/^\d+$/.test(token)) throw new Error(`Invalid selection: ${token}`);
    const value = Number(token);
    assertSelectionInRange(value, candidates);
    selected.add(value - 1);
  }
  return [...selected].sort((a, b) => a - b);
}

export function mergeScannedAccounts(
  config: Config,
  candidates: ScanCandidate[],
  selectedIndexes: number[],
): Config {
  const selected = new Set(selectedIndexes);
  return {
    ...config,
    accounts: candidates
      .filter((_, index) => selected.has(index))
      .map((candidate) => candidate.account),
  };
}
