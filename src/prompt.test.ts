import { describe, expect, it } from "vitest";
import { generatePrompt } from "./prompt.js";

describe("generatePrompt", () => {
  it("returns a string containing a math expression", () => {
    const prompt = generatePrompt();
    expect(prompt).toMatch(/\d+/);
  });

  it("produces varied prompts across multiple calls", () => {
    const prompts = new Set<string>();
    for (let i = 0; i < 20; i++) {
      prompts.add(generatePrompt());
    }
    expect(prompts.size).toBeGreaterThan(10);
  });

  it("uses different math operations", () => {
    const ops = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const prompt = generatePrompt();
      for (const op of ["+", "-", "*", "/"]) {
        if (prompt.includes(` ${op} `)) ops.add(op);
      }
    }
    expect(ops.size).toBeGreaterThanOrEqual(3);
  });
});
