import { describe, expect, it } from "vitest";
import { parseRateLimitReset } from "./rate-limit.js";

// Captured from a live HTTP 429 response (CLAUDE_CONFIG_DIR ping against a
// rate-limited account). The result string is the only place the CLI surfaces
// the reset time — there is no machine-readable header in the JSON.
const REAL_WEEKLY =
  "You've hit your weekly limit · resets 9pm (Europe/Stockholm)";

// A fixed reference instant in local time. Tests pass `now` explicitly so the
// computed resetAt is deterministic regardless of the machine clock.
function at(hour: number, minute = 0): Date {
  return new Date(2026, 5, 9, hour, minute, 0, 0); // 2026-06-09, local time
}

describe("parseRateLimitReset", () => {
  it("parses the real captured weekly-limit string", () => {
    const info = parseRateLimitReset(REAL_WEEKLY, at(14));
    expect(info).not.toBeNull();
    expect(info!.resetLabel).toBe("9pm");
    expect(info!.scope).toBe("weekly");
    // 9pm today, since now is 2pm.
    expect(info!.resetAt.getHours()).toBe(21);
    expect(info!.resetAt.getMinutes()).toBe(0);
    expect(info!.resetAt.getDate()).toBe(9);
  });

  it("rolls to tomorrow when the reset time already passed today", () => {
    const info = parseRateLimitReset(REAL_WEEKLY, at(22)); // now 10pm, past 9pm
    expect(info).not.toBeNull();
    expect(info!.resetAt.getHours()).toBe(21);
    expect(info!.resetAt.getDate()).toBe(10); // next day
  });

  it("keeps today when the reset time is still ahead", () => {
    const info = parseRateLimitReset(REAL_WEEKLY, at(8));
    expect(info!.resetAt.getDate()).toBe(9);
    expect(info!.resetAt.getHours()).toBe(21);
  });

  it("parses minutes (3:30pm)", () => {
    const info = parseRateLimitReset(
      "You've hit your 5-hour limit · resets 3:30pm",
      at(10),
    );
    expect(info).not.toBeNull();
    expect(info!.scope).toBe("5-hour");
    expect(info!.resetAt.getHours()).toBe(15);
    expect(info!.resetAt.getMinutes()).toBe(30);
    expect(info!.resetLabel).toBe("3:30pm");
  });

  it("treats 12am as midnight (hour 0)", () => {
    const info = parseRateLimitReset("resets 12am", at(20));
    expect(info!.resetAt.getHours()).toBe(0);
    // 20:00 → next midnight is tomorrow
    expect(info!.resetAt.getDate()).toBe(10);
  });

  it("treats 12pm as noon (hour 12)", () => {
    const info = parseRateLimitReset("resets 12pm", at(8));
    expect(info!.resetAt.getHours()).toBe(12);
    expect(info!.resetAt.getDate()).toBe(9);
  });

  it("is case- and whitespace-insensitive", () => {
    const info = parseRateLimitReset("RESETS   9PM", at(14));
    expect(info!.resetAt.getHours()).toBe(21);
    expect(info!.resetLabel).toBe("9pm");
  });

  it("returns null when there is no reset clause", () => {
    expect(
      parseRateLimitReset("You've hit your weekly limit", at(14)),
    ).toBeNull();
  });

  it("returns null for an unrelated string", () => {
    expect(parseRateLimitReset("pong", at(14))).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseRateLimitReset("", at(14))).toBeNull();
  });

  it("leaves scope null when the limit type is not present", () => {
    const info = parseRateLimitReset("resets 9pm", at(14));
    expect(info!.scope).toBeNull();
  });
});
