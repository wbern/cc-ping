import { describe, expect, it, vi } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  it("logs to stdout when quiet is false", () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const logger = createLogger({ quiet: false, stdout, stderr });
    logger.log("hello");
    expect(stdout).toHaveBeenCalledWith("hello");
  });

  it("suppresses log output when quiet is true", () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const logger = createLogger({ quiet: true, stdout, stderr });
    logger.log("hello");
    expect(stdout).not.toHaveBeenCalled();
  });

  it("always outputs errors even in quiet mode", () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const logger = createLogger({ quiet: true, stdout, stderr });
    logger.error("something went wrong");
    expect(stderr).toHaveBeenCalledWith("something went wrong");
  });

  it("defaults to console.log and console.error", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger({ quiet: false });
    logger.log("info");
    logger.error("err");
    expect(logSpy).toHaveBeenCalledWith("info");
    expect(errSpy).toHaveBeenCalledWith("err");
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
