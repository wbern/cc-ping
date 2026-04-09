import { afterEach, describe, expect, it } from "vitest";

const { green, red, yellow, blue } = await import("./color.js");

describe("color", () => {
  const origNoColor = process.env.NO_COLOR;
  const origForceColor = process.env.FORCE_COLOR;

  afterEach(() => {
    if (origNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = origNoColor;
    if (origForceColor === undefined) delete process.env.FORCE_COLOR;
    else process.env.FORCE_COLOR = origForceColor;
  });

  it("returns plain text when colors are disabled (non-TTY, no FORCE_COLOR)", () => {
    delete process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    // In test runner, stdout is not a TTY, so colors are disabled
    expect(green("ok")).toBe("ok");
    expect(red("FAIL")).toBe("FAIL");
    expect(yellow("unknown")).toBe("unknown");
    expect(blue("deferred")).toBe("deferred");
  });

  it("returns ANSI-wrapped text when FORCE_COLOR=1", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    expect(green("ok")).toBe("\x1b[32mok\x1b[0m");
    expect(red("FAIL")).toBe("\x1b[31mFAIL\x1b[0m");
    expect(yellow("unknown")).toBe("\x1b[33munknown\x1b[0m");
    expect(blue("deferred")).toBe("\x1b[34mdeferred\x1b[0m");
  });

  it("returns plain text when NO_COLOR is set even with FORCE_COLOR", () => {
    process.env.NO_COLOR = "1";
    process.env.FORCE_COLOR = "1";
    expect(green("ok")).toBe("ok");
  });

  it("returns plain text when FORCE_COLOR=0", () => {
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "0";
    expect(green("ok")).toBe("ok");
  });
});
