import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => join(tmpdir(), `cc-ping-default-${process.pid}`),
  };
});

vi.mock("./config.js", () => ({
  listAccounts: vi.fn(() => []),
  loadConfig: vi.fn(() => ({ accounts: [] })),
  saveConfig: vi.fn(),
}));

vi.mock("./identity.js", () => ({
  findDuplicates: vi.fn(() => new Map()),
}));

const { listAccounts } = await import("./config.js");
const { findDuplicates } = await import("./identity.js");
const { recordPing } = await import("./state.js");
const { showDefault } = await import("./default-command.js");

describe("showDefault", () => {
  const stateDir = join(
    tmpdir(),
    `cc-ping-default-${process.pid}`,
    ".config",
    "cc-ping",
  );

  beforeEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
    vi.mocked(listAccounts).mockReturnValue([]);
    vi.mocked(findDuplicates).mockReturnValue(new Map());
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("shows getting started message when no accounts configured", () => {
    const lines: string[] = [];
    showDefault((msg) => lines.push(msg));
    expect(lines[0]).toBe("No accounts configured.");
    expect(lines.join("\n")).toContain("cc-ping scan");
    expect(lines.join("\n")).toContain("cc-ping add");
  });

  it("shows account statuses and suggests ping when accounts need pinging", () => {
    vi.mocked(listAccounts).mockReturnValue([
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ]);
    const lines: string[] = [];
    showDefault((msg) => lines.push(msg));
    const output = lines.join("\n");
    expect(output).toContain("alice");
    expect(output).toContain("bob");
    expect(output).toContain("cc-ping ping");
    expect(output).toContain("cc-ping daemon start");
  });

  it("does not suggest ping when all accounts are active", () => {
    vi.mocked(listAccounts).mockReturnValue([
      { handle: "alice", configDir: "/tmp/alice" },
    ]);
    recordPing("alice", new Date("2025-01-01T00:00:00.000Z"));
    const now = new Date("2025-01-01T01:00:00.000Z");
    const lines: string[] = [];
    showDefault((msg) => lines.push(msg), now);
    const output = lines.join("\n");
    expect(output).toContain("alice");
    expect(output).toContain("active");
    expect(output).not.toContain("Suggested next steps");
  });

  it("suggests ping when only some need pinging", () => {
    vi.mocked(listAccounts).mockReturnValue([
      { handle: "alice", configDir: "/tmp/alice" },
      { handle: "bob", configDir: "/tmp/bob" },
    ]);
    recordPing("alice", new Date("2025-01-01T00:00:00.000Z"));
    const now = new Date("2025-01-01T01:00:00.000Z");
    const lines: string[] = [];
    showDefault((msg) => lines.push(msg), now);
    const output = lines.join("\n");
    expect(output).toContain("cc-ping ping");
    expect(output).toContain("Ping accounts that need it");
  });

  it("uses console.log by default", () => {
    vi.mocked(listAccounts).mockReturnValue([
      { handle: "alice", configDir: "/tmp/alice" },
    ]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    showDefault();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
