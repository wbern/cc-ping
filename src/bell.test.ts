import { describe, expect, it, vi } from "vitest";
import { ringBell } from "./bell.js";

describe("ringBell", () => {
  it("writes BEL character to provided writer", () => {
    const write = vi.fn();
    ringBell(write);
    expect(write).toHaveBeenCalledWith("\x07");
  });

  it("writes to process.stdout.write by default", () => {
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    ringBell();
    expect(spy).toHaveBeenCalledWith("\x07");
    spy.mockRestore();
  });
});
