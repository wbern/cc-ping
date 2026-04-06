import { execFile } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

const mockExecFile = vi.mocked(execFile);

const { pingAccounts } = await import("./ping.js");

function setupMock(error: Error | null) {
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      setTimeout(() => (cb as (err: Error | null) => void)(error), 10);
      return { stdin: { end: vi.fn() } } as unknown as ReturnType<
        typeof execFile
      >;
    },
  );
}

describe("pingAccounts", () => {
  it("pings accounts sequentially by default", async () => {
    setupMock(null);
    const accounts = [
      { handle: "a", configDir: "/tmp/a" },
      { handle: "b", configDir: "/tmp/b" },
    ];
    const results = await pingAccounts(accounts);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.success).toBe(true);
      expect(r.error).toBeUndefined();
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("pings accounts in parallel when option set", async () => {
    setupMock(null);
    const accounts = [
      { handle: "a", configDir: "/tmp/a" },
      { handle: "b", configDir: "/tmp/b" },
    ];
    const results = await pingAccounts(accounts, { parallel: true });
    expect(results).toHaveLength(2);
  });

  it("reports failure when execFile returns an error", async () => {
    setupMock(new Error("Command timed out"));
    const results = await pingAccounts([
      { handle: "fail", configDir: "/tmp/fail" },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe("Command timed out");
  });
});
