// Parse the human-readable reset time the Claude CLI puts in a rate-limit (HTTP
// 429) result body — e.g. "You've hit your weekly limit · resets 9pm
// (Europe/Stockholm)". The JSON has no machine-readable reset header, so this
// string is the only signal for *when* to try again.
//
// The clock time is interpreted in the host's LOCAL timezone. The CLI reports
// it in the account's configured zone (the parenthetical), which on a personal
// machine is the same as the host. A zone mismatch only makes us wake early —
// we re-parse and reschedule on the next still-limited attempt — so local
// interpretation degrades gracefully rather than silently wasting the window.

interface RateLimitInfo {
  // Absolute instant of the next reset, in the host's local timezone.
  resetAt: Date;
  // The reset time exactly as shown to the user, e.g. "9pm" or "3:30pm".
  resetLabel: string;
  // The limit type ("weekly", "5-hour", …) or null when not stated.
  scope: string | null;
}

const RESET_RE = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
const SCOPE_RE = /your\s+(.+?)\s+limit/i;

export function parseRateLimitReset(
  result: string,
  now: Date,
): RateLimitInfo | null {
  if (!result) return null;
  const match = RESET_RE.exec(result);
  if (!match) return null;

  const rawHour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3].toLowerCase();

  // 12am → 0, 12pm → 12, otherwise add 12 for pm.
  let hour = rawHour % 12;
  if (meridiem === "pm") hour += 12;

  const resetAt = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hour,
    minute,
    0,
    0,
  );
  // Reset time already passed today → it's the same wall-clock time tomorrow.
  if (resetAt.getTime() <= now.getTime()) {
    resetAt.setDate(resetAt.getDate() + 1);
  }

  const minutePart = match[2] ? `:${match[2]}` : "";
  const resetLabel = `${rawHour}${minutePart}${meridiem}`;

  const scopeMatch = SCOPE_RE.exec(result);
  const scope = scopeMatch ? scopeMatch[1] : null;

  return { resetAt, resetLabel, scope };
}
