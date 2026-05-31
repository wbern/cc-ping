import { afterEach, describe, expect, it, vi } from "vitest";
import { sendRemoteNotification } from "./remote-notify.js";

const URL = "https://ntfy.sh/secret-topic";

function okResponse() {
  return { ok: true, status: 200 } as Response;
}

function errResponse(status: number) {
  return { ok: false, status } as Response;
}

describe("sendRemoteNotification", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses a non-HTTPS URL without fetching", async () => {
    const log = vi.fn();
    const fetchMock = vi.fn();

    const result = await sendRemoteNotification(
      "http://ntfy.sh/secret",
      { title: "t", body: "b" },
      { fetch: fetchMock, log },
    );

    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      "remote notification skipped: URL must be HTTPS",
    );
  });

  it("posts the body with Title and Priority headers and returns true", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());

    const result = await sendRemoteNotification(
      URL,
      { title: "cc-ping", body: "hello", priority: "high" },
      { fetch: fetchMock, retries: 0 },
    );

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(URL);
    expect(init.method).toBe("POST");
    expect(init.body).toBe("hello");
    expect(init.headers).toEqual({ Title: "cc-ping", Priority: "high" });
  });

  it("omits the Priority header when no priority is given", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());

    await sendRemoteNotification(
      URL,
      { title: "cc-ping", body: "hello" },
      { fetch: fetchMock, retries: 0 },
    );

    expect(fetchMock.mock.calls[0][1].headers).toEqual({ Title: "cc-ping" });
  });

  it("returns false on a permanent 4xx without retrying", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(404));
    const log = vi.fn();

    const result = await sendRemoteNotification(
      URL,
      { title: "t", body: "b" },
      { fetch: fetchMock, retries: 2, log },
    );

    expect(result).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("remote notification failed: HTTP 404");
  });

  it("retries a transient 5xx and succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errResponse(503))
      .mockResolvedValueOnce(okResponse());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const random = vi.fn().mockReturnValue(0);

    const result = await sendRemoteNotification(
      URL,
      { title: "t", body: "b" },
      { fetch: fetchMock, retries: 2, sleep, random },
    );

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(200);
  });

  it("retries a 429 and gives up after exhausting retries", async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(429));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const random = vi.fn().mockReturnValue(0);
    const log = vi.fn();

    const result = await sendRemoteNotification(
      URL,
      { title: "t", body: "b" },
      { fetch: fetchMock, retries: 1, sleep, random, log },
    );

    expect(result).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      "remote notification failed: retries exhausted",
    );
  });

  it("retries a network error and gives up", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await sendRemoteNotification(
      URL,
      { title: "t", body: "b" },
      { fetch: fetchMock, retries: 1, sleep, random: () => 0.5 },
    );

    expect(result).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts the request when it exceeds the timeout", async () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );

    const result = await sendRemoteNotification(
      URL,
      { title: "t", body: "b" },
      { fetch: fetchMock, retries: 0, timeoutMs: 5 },
    );

    expect(result).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the global fetch and default options when deps are omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendRemoteNotification(URL, {
      title: "cc-ping",
      body: "hi",
      priority: "default",
    });

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses default sleep and jitter when retrying without overrides", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errResponse(500))
      .mockResolvedValueOnce(okResponse());

    const result = await sendRemoteNotification(
      URL,
      { title: "t", body: "b" },
      { fetch: fetchMock },
    );

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
