import { describe, expect, it } from "vitest";
import { generateCompletion } from "./completions.js";

describe("generateCompletion", () => {
  it("generates bash completion script", () => {
    const script = generateCompletion("bash");
    expect(script).toContain("_cc_ping");
    expect(script).toContain("complete -F");
    expect(script).toContain("cc-ping");
    expect(script).toContain("ping");
    expect(script).toContain("scan");
    expect(script).toContain("suggest");
    expect(script).toContain("cc-ping list");
    expect(script).toContain("daemon");
    expect(script).toContain("start stop status");
  });

  it("generates zsh completion script", () => {
    const script = generateCompletion("zsh");
    expect(script).toContain("#compdef cc-ping");
    expect(script).toContain("_cc_ping");
    expect(script).toContain("ping");
    expect(script).toContain("scan");
    expect(script).toContain("cc-ping list");
    expect(script).toContain("daemon");
    expect(script).toContain("Start the daemon process");
  });

  it("generates fish completion script", () => {
    const script = generateCompletion("fish");
    expect(script).toContain("complete -c cc-ping");
    expect(script).toContain("ping");
    expect(script).toContain("scan");
    expect(script).toContain("cc-ping list");
    expect(script).toContain("daemon");
    expect(script).toContain("Start the daemon");
  });

  it("throws for unsupported shell", () => {
    expect(() => generateCompletion("powershell")).toThrow(
      "Unsupported shell: powershell",
    );
  });
});
