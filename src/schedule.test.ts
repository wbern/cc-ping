import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildHourHistogram,
  checkRecentActivity,
  findOptimalPingHour,
  getAccountSchedule,
  isRecentlyActive,
  parseSmartSchedule,
  readAccountSchedule,
  shouldDefer,
} from "./schedule.js";

describe("buildHourHistogram", () => {
  it("counts timestamps into 24 hour-of-day bins", () => {
    const timestamps = [
      new Date("2026-04-01T09:00:00Z"), // hour 9
      new Date("2026-04-01T09:30:00Z"), // hour 9
      new Date("2026-04-02T14:00:00Z"), // hour 14
      new Date("2026-04-03T14:15:00Z"), // hour 14
      new Date("2026-04-03T14:45:00Z"), // hour 14
      new Date("2026-04-04T22:00:00Z"), // hour 22
    ];

    const histogram = buildHourHistogram(timestamps);

    expect(histogram).toHaveLength(24);
    expect(histogram[9]).toBe(2);
    expect(histogram[14]).toBe(3);
    expect(histogram[22]).toBe(1);
    expect(histogram[0]).toBe(0);
    expect(histogram[12]).toBe(0);
  });
});

describe("findOptimalPingHour", () => {
  it("places ping so the window expires at the midpoint of peak activity", () => {
    // Activity concentrated at hours 9-17 (work day)
    // Densest 5h window: 11-15, midpoint = 13
    // Optimal ping = 13 - 5 = 8 → window 8-13 expires at midpoint,
    // next ping at 13 covers the peak, defer zone [3,8) is pre-activity
    const histogram = new Array(24).fill(0);
    histogram[9] = 5;
    histogram[10] = 8;
    histogram[11] = 10;
    histogram[12] = 12;
    histogram[13] = 15;
    histogram[14] = 12;
    histogram[15] = 10;
    histogram[16] = 8;
    histogram[17] = 5;

    expect(findOptimalPingHour(histogram)).toBe(8);
  });

  it("returns -1 for an empty histogram", () => {
    const histogram = new Array(24).fill(0);
    expect(findOptimalPingHour(histogram)).toBe(-1);
  });

  it("wraps around midnight correctly", () => {
    // Activity at hours 1-3 → densest 5h window starts at 0, midpoint = 2
    // Optimal ping = 2 - 5 = -3 → 21
    const histogram = new Array(24).fill(0);
    histogram[1] = 5;
    histogram[2] = 10;
    histogram[3] = 5;

    expect(findOptimalPingHour(histogram)).toBe(21);
  });

  it("handles night-owl activity spanning midnight", () => {
    // Activity from 10pm-2am: hours 22, 23, 0, 1, 2
    // Densest 5h window starts at 22, midpoint = 0
    // Optimal ping = 0 - 5 = -5 → 19
    const histogram = new Array(24).fill(0);
    histogram[22] = 5;
    histogram[23] = 10;
    histogram[0] = 10;
    histogram[1] = 10;
    histogram[2] = 5;

    expect(findOptimalPingHour(histogram)).toBe(19);
  });

  it("picks the denser peak for bimodal activity", () => {
    // Morning peak: hours 8-10 (total 15)
    // Evening peak: hours 20-22 (total 30) — denser
    // Densest 5h window starts at 18, midpoint = 20
    // Optimal ping = 20 - 5 = 15, defer zone [10, 15)
    // Morning ping at 9 is outside defer zone → proceeds normally ✓
    // Evening covered by the deferred ping chain ✓
    const histogram = new Array(24).fill(0);
    histogram[8] = 5;
    histogram[9] = 5;
    histogram[10] = 5;
    histogram[20] = 10;
    histogram[21] = 10;
    histogram[22] = 10;

    const result = findOptimalPingHour(histogram);
    expect(result).toBe(15);
  });
});

describe("shouldDefer", () => {
  it("defers when current time is in the 5h window before optimal ping", () => {
    // Optimal ping at hour 8, current time is hour 5 → 3h before optimal → in defer zone
    const now = new Date("2026-04-08T05:00:00Z");
    const result = shouldDefer(now, 8);
    expect(result).toEqual({ defer: true, deferUntilUtcHour: 8 });
  });

  it("does not defer when current time is outside the defer zone", () => {
    // Optimal ping at hour 8, defer zone = [3, 8)
    // Current time is hour 14 → outside zone
    const now = new Date("2026-04-08T14:00:00Z");
    expect(shouldDefer(now, 8)).toEqual({ defer: false });
  });

  it("does not defer when current time equals optimal ping hour", () => {
    // Optimal ping at hour 8, current time is hour 8 → it's ping time, not defer
    const now = new Date("2026-04-08T08:00:00Z");
    expect(shouldDefer(now, 8)).toEqual({ defer: false });
  });

  it("handles defer zone wrapping around midnight", () => {
    // Optimal ping at hour 2, defer zone = [21, 2)
    // Current time is hour 23 → in defer zone (wrapped)
    const now = new Date("2026-04-08T23:00:00Z");
    expect(shouldDefer(now, 2)).toEqual({ defer: true, deferUntilUtcHour: 2 });
  });

  it("does not defer when outside a wrapped defer zone", () => {
    // Optimal ping at hour 2, defer zone = [21, 2)
    // Current time is hour 10 → NOT in defer zone
    const now = new Date("2026-04-08T10:00:00Z");
    expect(shouldDefer(now, 2)).toEqual({ defer: false });
  });
});

describe("findOptimalPingHour + shouldDefer integration", () => {
  it("does not defer at the start of workday activity", () => {
    // Workday 9-17: densest 5h window is 11-15
    // Optimal ping = 8, defer zone [3, 8)
    // 9am is outside defer zone → proceeds
    const histogram = new Array(24).fill(0);
    histogram[9] = 5;
    histogram[10] = 8;
    histogram[11] = 10;
    histogram[12] = 12;
    histogram[13] = 15;
    histogram[14] = 12;
    histogram[15] = 10;
    histogram[16] = 8;
    histogram[17] = 5;

    const optimalHour = findOptimalPingHour(histogram);
    const result = shouldDefer(new Date("2026-04-08T09:00:00Z"), optimalHour);
    expect(result.defer).toBe(false);
  });

  it("defers pre-dawn pings for a workday user to align with activity", () => {
    // Same workday histogram, optimal = 8, defer zone [3, 8)
    // 5am is in defer zone → deferred to 8
    const histogram = new Array(24).fill(0);
    histogram[9] = 5;
    histogram[10] = 8;
    histogram[11] = 10;
    histogram[12] = 12;
    histogram[13] = 15;
    histogram[14] = 12;
    histogram[15] = 10;
    histogram[16] = 8;
    histogram[17] = 5;

    const optimalHour = findOptimalPingHour(histogram);
    const result = shouldDefer(new Date("2026-04-08T05:00:00Z"), optimalHour);
    expect(result).toEqual({ defer: true, deferUntilUtcHour: 8 });
  });

  it("does not defer morning ping for bimodal user", () => {
    // Morning 8-10 (light), evening 20-22 (heavy)
    // Optimal = 15, defer zone [10, 15)
    // 9am is outside defer zone → morning gets coverage
    const histogram = new Array(24).fill(0);
    histogram[8] = 5;
    histogram[9] = 5;
    histogram[10] = 5;
    histogram[20] = 10;
    histogram[21] = 10;
    histogram[22] = 10;

    const optimalHour = findOptimalPingHour(histogram);
    const result = shouldDefer(new Date("2026-04-08T09:00:00Z"), optimalHour);
    expect(result.defer).toBe(false);
  });

  it("defers midday ping for bimodal user to align with evening peak", () => {
    // Same bimodal, optimal = 15, defer zone [10, 15)
    // 12pm is in defer zone → deferred to 15, so window covers evening peak
    const histogram = new Array(24).fill(0);
    histogram[8] = 5;
    histogram[9] = 5;
    histogram[10] = 5;
    histogram[20] = 10;
    histogram[21] = 10;
    histogram[22] = 10;

    const optimalHour = findOptimalPingHour(histogram);
    const result = shouldDefer(new Date("2026-04-08T12:00:00Z"), optimalHour);
    expect(result).toEqual({ defer: true, deferUntilUtcHour: 15 });
  });

  it("does not defer for night-owl during active hours", () => {
    // Activity 22-2, optimal = 19, defer zone [14, 19)
    // 23:00 is outside defer zone → proceeds
    const histogram = new Array(24).fill(0);
    histogram[22] = 5;
    histogram[23] = 10;
    histogram[0] = 10;
    histogram[1] = 10;
    histogram[2] = 5;

    const optimalHour = findOptimalPingHour(histogram);
    const result = shouldDefer(new Date("2026-04-08T23:00:00Z"), optimalHour);
    expect(result.defer).toBe(false);
  });
});

describe("getAccountSchedule", () => {
  it("computes schedule from history lines", () => {
    const now = new Date("2026-04-08T12:00:00Z");
    // Start from midnight so hour offsets map directly to UTC hours
    const baseMidnight = new Date("2026-03-25T00:00:00Z").getTime();

    // Generate activity at hours 9-17 UTC over 10 days
    // (cutoff trims day 0 hours 9-11, so hours 12-17 have 10 events each,
    //  hours 9-11 have 9 → densest 5h window starts at 12, midpoint 14,
    //  optimal ping = 14 - 5 = 9)
    const lines: string[] = [];
    for (let day = 0; day < 10; day++) {
      for (let hour = 9; hour <= 17; hour++) {
        const ts =
          baseMidnight + day * 24 * 60 * 60 * 1000 + hour * 60 * 60 * 1000;
        lines.push(JSON.stringify({ timestamp: ts }));
      }
    }

    const result = getAccountSchedule(lines, now);
    expect(result).not.toBeNull();
    expect(result!.optimalPingHour).toBe(9);
    expect(result!.peakStart).toBe(12);
    expect(result!.peakEnd).toBe(17);
  });

  it("returns null with fewer than 7 days of data", () => {
    const now = new Date("2026-04-08T12:00:00Z");
    // Only 3 days of activity
    const lines: string[] = [];
    for (let day = 0; day < 3; day++) {
      const ts = now.getTime() - day * 24 * 60 * 60 * 1000;
      lines.push(JSON.stringify({ timestamp: ts }));
    }

    expect(getAccountSchedule(lines, now)).toBeNull();
  });

  it("returns null for a flat histogram", () => {
    const now = new Date("2026-04-08T12:00:00Z");
    const fourteenDaysAgo = now.getTime() - 14 * 24 * 60 * 60 * 1000;

    // Spread activity evenly across all 24 hours over 14 days
    const lines: string[] = [];
    for (let day = 0; day < 14; day++) {
      for (let hour = 0; hour < 24; hour++) {
        const ts =
          fourteenDaysAgo + day * 24 * 60 * 60 * 1000 + hour * 60 * 60 * 1000;
        lines.push(JSON.stringify({ timestamp: ts }));
      }
    }

    expect(getAccountSchedule(lines, now)).toBeNull();
  });

  it("skips malformed JSON lines", () => {
    const now = new Date("2026-04-08T12:00:00Z");
    const baseMidnight = new Date("2026-03-25T00:00:00Z").getTime();

    const lines: string[] = ["not-json", "{bad"];
    for (let day = 0; day < 10; day++) {
      for (let hour = 9; hour <= 17; hour++) {
        const ts =
          baseMidnight + day * 24 * 60 * 60 * 1000 + hour * 60 * 60 * 1000;
        lines.push(JSON.stringify({ timestamp: ts }));
      }
    }

    const result = getAccountSchedule(lines, now);
    expect(result).not.toBeNull();
    expect(result!.optimalPingHour).toBe(9);
  });

  it("skips entries without numeric timestamp", () => {
    const now = new Date("2026-04-08T12:00:00Z");
    const baseMidnight = new Date("2026-03-25T00:00:00Z").getTime();

    const lines = [JSON.stringify({ timestamp: "not-a-number" })];
    for (let day = 0; day < 10; day++) {
      for (let hour = 9; hour <= 17; hour++) {
        const ts =
          baseMidnight + day * 24 * 60 * 60 * 1000 + hour * 60 * 60 * 1000;
        lines.push(JSON.stringify({ timestamp: ts }));
      }
    }

    const result = getAccountSchedule(lines, now);
    expect(result).not.toBeNull();
  });

  it("ignores data before resetAt when provided", () => {
    const now = new Date("2026-04-08T12:00:00Z");
    const baseMidnight = new Date("2026-03-25T00:00:00Z").getTime();

    // Generate 10 days of activity at hours 9-17
    const lines: string[] = [];
    for (let day = 0; day < 10; day++) {
      for (let hour = 9; hour <= 17; hour++) {
        const ts =
          baseMidnight + day * 24 * 60 * 60 * 1000 + hour * 60 * 60 * 1000;
        lines.push(JSON.stringify({ timestamp: ts }));
      }
    }

    // Reset at April 5 — only 3 days remain, below MIN_DAYS threshold
    const resetAt = new Date("2026-04-05T00:00:00Z");
    expect(getAccountSchedule(lines, now, resetAt)).toBeNull();
  });

  it("filters out timestamps older than 14 days", () => {
    const now = new Date("2026-04-08T12:00:00Z");
    const baseMidnight = new Date("2026-03-25T00:00:00Z").getTime();

    // Old entry beyond 14 days
    const oldTs = now.getTime() - 15 * 24 * 60 * 60 * 1000;
    const lines = [JSON.stringify({ timestamp: oldTs })];

    for (let day = 0; day < 10; day++) {
      for (let hour = 9; hour <= 17; hour++) {
        const ts =
          baseMidnight + day * 24 * 60 * 60 * 1000 + hour * 60 * 60 * 1000;
        lines.push(JSON.stringify({ timestamp: ts }));
      }
    }

    const result = getAccountSchedule(lines, now);
    expect(result).not.toBeNull();
  });
});

describe("readAccountSchedule", () => {
  const testDir = join(tmpdir(), `cc-ping-schedule-${process.pid}`);

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("reads history.jsonl from configDir and returns schedule", () => {
    const now = new Date("2026-04-08T12:00:00Z");
    const baseMidnight = new Date("2026-03-25T00:00:00Z").getTime();

    const lines: string[] = [];
    for (let day = 0; day < 10; day++) {
      for (let hour = 9; hour <= 17; hour++) {
        const ts =
          baseMidnight + day * 24 * 60 * 60 * 1000 + hour * 60 * 60 * 1000;
        lines.push(JSON.stringify({ timestamp: ts }));
      }
    }
    writeFileSync(join(testDir, "history.jsonl"), lines.join("\n"));

    const result = readAccountSchedule(testDir, now);
    expect(result).not.toBeNull();
    expect(result!.optimalPingHour).toBe(9);
  });

  it("returns null when history.jsonl does not exist", () => {
    const result = readAccountSchedule(testDir);
    expect(result).toBeNull();
  });
});

describe("parseSmartSchedule", () => {
  it("returns true for truthy values", () => {
    expect(parseSmartSchedule("true")).toBe(true);
    expect(parseSmartSchedule("on")).toBe(true);
    expect(parseSmartSchedule("1")).toBe(true);
  });

  it("returns false for falsy values", () => {
    expect(parseSmartSchedule("false")).toBe(false);
    expect(parseSmartSchedule("off")).toBe(false);
    expect(parseSmartSchedule("0")).toBe(false);
  });

  it("is case insensitive", () => {
    expect(parseSmartSchedule("TRUE")).toBe(true);
    expect(parseSmartSchedule("False")).toBe(false);
    expect(parseSmartSchedule("ON")).toBe(true);
    expect(parseSmartSchedule("OFF")).toBe(false);
  });

  it("throws for invalid values", () => {
    expect(() => parseSmartSchedule("maybe")).toThrow(
      'Invalid smart-schedule value: "maybe"',
    );
  });
});

describe("isRecentlyActive", () => {
  it("returns true when last activity is within 5 hours", () => {
    const now = new Date("2026-04-09T14:00:00.000Z");
    const twoHoursAgo = now.getTime() - 2 * 60 * 60 * 1000;
    const lines = [JSON.stringify({ timestamp: twoHoursAgo })];
    expect(isRecentlyActive(lines, now)).toBe(true);
  });

  it("returns false when last activity is older than 5 hours", () => {
    const now = new Date("2026-04-09T14:00:00.000Z");
    const sixHoursAgo = now.getTime() - 6 * 60 * 60 * 1000;
    const lines = [JSON.stringify({ timestamp: sixHoursAgo })];
    expect(isRecentlyActive(lines, now)).toBe(false);
  });

  it("returns false for empty history", () => {
    const now = new Date("2026-04-09T14:00:00.000Z");
    expect(isRecentlyActive([], now)).toBe(false);
  });

  it("uses the most recent timestamp from multiple entries", () => {
    const now = new Date("2026-04-09T14:00:00.000Z");
    const sixHoursAgo = now.getTime() - 6 * 60 * 60 * 1000;
    const oneHourAgo = now.getTime() - 1 * 60 * 60 * 1000;
    const lines = [
      JSON.stringify({ timestamp: sixHoursAgo }),
      JSON.stringify({ timestamp: oneHourAgo }),
    ];
    expect(isRecentlyActive(lines, now)).toBe(true);
  });

  it("ignores string timestamps from cc-ping history", () => {
    const now = new Date("2026-04-09T14:00:00.000Z");
    const lines = [JSON.stringify({ timestamp: "2026-04-09T13:00:00.000Z" })];
    expect(isRecentlyActive(lines, now)).toBe(false);
  });

  it("skips malformed lines", () => {
    const now = new Date("2026-04-09T14:00:00.000Z");
    const oneHourAgo = now.getTime() - 1 * 60 * 60 * 1000;
    const lines = ["not json{{{", JSON.stringify({ timestamp: oneHourAgo })];
    expect(isRecentlyActive(lines, now)).toBe(true);
  });
});

describe("checkRecentActivity", () => {
  const dir = join(tmpdir(), `cc-ping-recent-${process.pid}`);

  beforeEach(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns true when history.jsonl has recent activity", () => {
    const now = new Date("2026-04-09T14:00:00.000Z");
    const oneHourAgo = now.getTime() - 1 * 60 * 60 * 1000;
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "history.jsonl"),
      JSON.stringify({ timestamp: oneHourAgo }),
    );
    expect(checkRecentActivity(dir, now)).toBe(true);
  });

  it("returns false when history.jsonl does not exist", () => {
    expect(checkRecentActivity(dir)).toBe(false);
  });
});
