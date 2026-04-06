import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfigDir, setConfigDir } from "./paths.js";

describe("resolveConfigDir", () => {
  afterEach(() => {
    setConfigDir("");
    delete process.env.CC_PING_CONFIG;
  });

  it("returns default path when no override is provided", () => {
    const result = resolveConfigDir();
    expect(result).toBe(join(homedir(), ".config", "cc-ping"));
  });

  it("returns CC_PING_CONFIG env var when set", () => {
    process.env.CC_PING_CONFIG = "/custom/config/dir";
    const result = resolveConfigDir();
    expect(result).toBe("/custom/config/dir");
  });

  it("prefers explicit setConfigDir over env var", () => {
    process.env.CC_PING_CONFIG = "/from/env";
    setConfigDir("/from/flag");
    const result = resolveConfigDir();
    expect(result).toBe("/from/flag");
  });

  it("falls back to env var after clearing override", () => {
    setConfigDir("/from/flag");
    process.env.CC_PING_CONFIG = "/from/env";
    setConfigDir("");
    const result = resolveConfigDir();
    expect(result).toBe("/from/env");
  });
});
