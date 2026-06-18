import { describe, expect, it } from "vitest";
import { generatePrompt } from "./prompt.js";

function fixedRandom(value: number): () => number {
  return () => value;
}

describe("generatePrompt", () => {
  it("returns a prompt in mixed mode by default", () => {
    const prompt = generatePrompt(undefined, fixedRandom(0));

    expect(prompt).toBeTruthy();
    expect(prompt).toMatch(/[?.]$/);
  });

  it("can select each prompt family in mixed mode", () => {
    const math = generatePrompt("mixed", fixedRandom(0));
    const chess = generatePrompt("mixed", fixedRandom(0.04));
    const trivia = generatePrompt("mixed", fixedRandom(0.08));
    const tinyChat = generatePrompt("mixed", fixedRandom(0.68));

    expect(math).toMatch(/\d+ \+ \d+/);
    expect(chess).toContain("FEN: ");
    expect(trivia).toContain("grass");
    expect(tinyChat).toContain("sentence");
  });

  it("uses different math operations", () => {
    const ops = new Set<string>();
    for (const random of [
      fixedRandom(0),
      fixedRandom(0.26),
      fixedRandom(0.51),
      fixedRandom(0.76),
    ]) {
      const prompt = generatePrompt("math", random);
      for (const op of ["+", "-", "*", "/"]) {
        if (prompt.includes(` ${op} `)) ops.add(op);
      }
    }
    expect(ops).toEqual(new Set(["+", "-", "*", "/"]));
  });

  it("includes non-math prompts", () => {
    const prompt = generatePrompt("mixed", fixedRandom(0.08));

    expect(prompt).not.toMatch(/\d+ [+\-*/] \d+/);
  });

  it("supports trivia prompts", () => {
    const prompt = generatePrompt("trivia", fixedRandom(0));

    expect(prompt).not.toMatch(/\d+ [+\-*/] \d+/);
    expect(prompt).toContain("color");
    expect(prompt.length).toBeLessThan(140);
  });

  it("supports tiny-chat prompts", () => {
    const prompt = generatePrompt("tiny-chat", fixedRandom(0.1));

    expect(prompt).not.toMatch(/\d+ [+\-*/] \d+/);
    expect(prompt).toContain("sentence");
    expect(prompt.length).toBeLessThan(140);
  });

  it("supports chess prompts with FEN questions", () => {
    const prompt = generatePrompt("chess", fixedRandom(0));

    expect(prompt).toContain("FEN: ");
    expect(prompt).toContain("Square only: ");
    expect(prompt).toContain("/");
  });

  it("supports chess square occupancy prompts", () => {
    const prompt = generatePrompt("chess", fixedRandom(0.9));

    expect(prompt).toContain("FEN: ");
    expect(prompt).toContain("Yes/no: ");
  });

  it("supports chess square contents prompts", () => {
    const prompt = generatePrompt("chess", fixedRandom(0.5));

    expect(prompt).toContain("FEN: ");
    expect(prompt).toContain("Piece only: ");
  });
});
