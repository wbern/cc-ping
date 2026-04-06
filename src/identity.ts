import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountConfig, AccountIdentity } from "./types.js";

export function readAccountIdentity(configDir: string): AccountIdentity | null {
  let raw: string;
  try {
    raw = readFileSync(join(configDir, ".claude.json"), "utf-8");
  } catch {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const oauth = parsed.oauthAccount as Record<string, unknown> | undefined;
  if (!oauth) return null;

  const accountUuid = oauth.accountUuid;
  const email = oauth.emailAddress;
  if (typeof accountUuid !== "string" || typeof email !== "string") return null;

  return { accountUuid, email };
}

export interface DuplicateGroup {
  handles: string[];
  email: string;
}

export function findDuplicates(
  accounts: AccountConfig[],
): Map<string, DuplicateGroup> {
  const byUuid = new Map<string, { handles: string[]; email: string }>();

  for (const account of accounts) {
    const identity = readAccountIdentity(account.configDir);
    if (!identity) continue;

    const existing = byUuid.get(identity.accountUuid);
    if (existing) {
      existing.handles.push(account.handle);
    } else {
      byUuid.set(identity.accountUuid, {
        handles: [account.handle],
        email: identity.email,
      });
    }
  }

  // Only return entries with 2+ handles
  const result = new Map<string, DuplicateGroup>();
  for (const [uuid, group] of byUuid) {
    if (group.handles.length >= 2) {
      result.set(uuid, group);
    }
  }
  return result;
}
