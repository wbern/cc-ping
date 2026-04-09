import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildHourHistogram,
  findOptimalPingHour,
  getAccountSchedule,
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
  it("returns midpoint of activity minus 5 hours", () => {
    // Activity concentrated at hours 9-17 (work day)
    // Midpoint = 13, optimal ping = 13 - 5 = 8
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
    // Activity centered at hour 2 → midpoint = 2 → optimal = 2 - 5 = -3 → 21
    const histogram = new Array(24).fill(0);
    histogram[1] = 5;
    histogram[2] = 10;
    histogram[3] = 5;

    expect(findOptimalPingHour(histogram)).toBe(21);
  });

  it("handles night-owl activity spanning midnight", () => {
    // Activity from 10pm-2am: hours 22, 23, 0, 1, 2
    // True midpoint is ~midnight (hour 0), optimal = 0 - 5 = 19
    const histogram = new Array(24).fill(0);
    histogram[22] = 5;
    histogram[23] = 10;
    histogram[0] = 10;
    histogram[1] = 10;
    histogram[2] = 5;

    expect(findOptimalPingHour(histogram)).toBe(19);
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

describe("getAccountSchedule", () => {
  it("computes schedule from history lines", () => {
    const now = new Date("2026-04-08T12:00:00Z");
    // Start from midnight so hour offsets map directly to UTC hours
    const baseMidnight = new Date("2026-03-25T00:00:00Z").getTime();

    // Generate activity at hours 9-17 UTC over 10 days
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
    expect(result!.optimalPingHour).toBe(8);
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
    expect(result!.optimalPingHour).toBe(8);
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
    expect(result!.optimalPingHour).toBe(8);
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
