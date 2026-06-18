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
    expect(script).toContain("reset");
    expect(script).toContain("config");
    expect(script).toContain("pingMode");
    expect(script).toContain("model");
    expect(script).toContain("cc-ping list");
    expect(script).toContain("daemon");
    expect(script).toContain("start stop status install uninstall");
    expect(script).toContain("install");
    expect(script).toContain("cleanup");
    expect(script).toContain("--dry-run");
  });

  it("generates zsh completion script", () => {
    const script = generateCompletion("zsh");
    expect(script).toContain("#compdef cc-ping");
    expect(script).toContain("_cc_ping");
    expect(script).toContain("ping");
    expect(script).toContain("scan");
    expect(script).toContain("cc-ping list");
    expect(script).toContain("config:Show or update settings");
    expect(script).toContain("reset:Manage reset overrides");
    expect(script).toContain("promptStyle");
    expect(script).toContain("model");
    expect(script).toContain("daemon");
    expect(script).toContain("Start the daemon process");
    expect(script).toContain("Install as system service");
    expect(script).toContain("Remove system service");
    expect(script).toContain("cleanup:Remove orphan state entries");
    expect(script).toContain("--dry-run[Show what would be removed");
  });

  it("generates fish completion script", () => {
    const script = generateCompletion("fish");
    expect(script).toContain("complete -c cc-ping");
    expect(script).toContain("ping");
    expect(script).toContain("scan");
    expect(script).toContain("cc-ping list");
    expect(script).toContain("complete -c cc-ping");
    expect(script).toContain("Show or update settings");
    expect(script).toContain("Manage reset overrides");
    expect(script).toContain("interactiveExitDelayMs");
    expect(script).toContain("model");
    expect(script).toContain("daemon");
    expect(script).toContain("Start the daemon");
    expect(script).toContain("Install as system service");
    expect(script).toContain("Remove system service");
    expect(script).toContain("-a cleanup");
    expect(script).toContain("-l dry-run");
  });

  it("throws for unsupported shell", () => {
    expect(() => generateCompletion("powershell")).toThrow(
      "Unsupported shell: powershell",
    );
  });
});
