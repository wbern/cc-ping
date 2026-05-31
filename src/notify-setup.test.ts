import { describe, expect, it } from "vitest";
import {
  buildNotifyUrl,
  DEFAULT_NTFY_SERVER,
  generateTopic,
} from "./notify-setup.js";

describe("generateTopic", () => {
  it("prefixes the generated id with cc-ping-", () => {
    expect(generateTopic(() => "abc123")).toBe("cc-ping-abc123");
  });

  it("uses a real UUID by default", () => {
    const topic = generateTopic();
    expect(topic).toMatch(/^cc-ping-[0-9a-f-]{36}$/);
  });
});

describe("buildNotifyUrl", () => {
  it("builds a URL against the default ntfy.sh server", () => {
    expect(buildNotifyUrl("my-topic")).toBe("https://ntfy.sh/my-topic");
  });

  it("uses a custom HTTPS server", () => {
    expect(buildNotifyUrl("my-topic", "https://ntfy.example.com")).toBe(
      "https://ntfy.example.com/my-topic",
    );
  });

  it("strips a trailing slash from the server", () => {
    expect(buildNotifyUrl("my-topic", "https://ntfy.sh/")).toBe(
      "https://ntfy.sh/my-topic",
    );
  });

  it("rejects a non-HTTPS server", () => {
    expect(() => buildNotifyUrl("my-topic", "http://ntfy.sh")).toThrow(
      "Notification server must be HTTPS",
    );
  });

  it("exposes the default server constant", () => {
    expect(DEFAULT_NTFY_SERVER).toBe("https://ntfy.sh");
  });
});
