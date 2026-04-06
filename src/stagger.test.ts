import { describe, expect, it } from "vitest";
import { calculateStagger, parseStagger } from "./stagger.js";

describe("calculateStagger", () => {
  it("returns 0 for a single account", () => {
    expect(calculateStagger(1)).toBe(0);
  });

  it("divides window evenly across accounts", () => {
    // 5h window = 18_000_000ms, 3 accounts -> 6_000_000ms (100 min)
    const result = calculateStagger(3);
    expect(result).toBe(6_000_000);
  });

  it("divides window evenly for 2 accounts", () => {
    // 5h / 2 = 2.5h = 9_000_000ms
    const result = calculateStagger(2);
    expect(result).toBe(9_000_000);
  });

  it("accepts custom window duration", () => {
    // 60 min window, 3 accounts -> 20 min = 1_200_000ms
    const result = calculateStagger(3, 60 * 60 * 1000);
    expect(result).toBe(1_200_000);
  });
});

describe("parseStagger", () => {
  it("parses numeric minutes value", () => {
    expect(parseStagger("10", 3)).toBe(600_000);
  });

  it("calculates auto stagger based on account count", () => {
    expect(parseStagger("auto", 3)).toBe(6_000_000);
  });

  it("returns 0 for auto with single account", () => {
    expect(parseStagger("auto", 1)).toBe(0);
  });

  it("throws on invalid value", () => {
    expect(() => parseStagger("abc", 3)).toThrow("Invalid stagger value: abc");
  });

  it("throws on negative value", () => {
    expect(() => parseStagger("-5", 3)).toThrow(
      "Stagger must be a positive number",
    );
  });
});
