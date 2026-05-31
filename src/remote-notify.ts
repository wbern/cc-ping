// Remote phone notifications via ntfy.sh (or any compatible HTTP push endpoint).
//
// The topic string in the URL IS the credential, so the URL is treated as a
// secret: it must be HTTPS and is never logged. A failed POST returns false and
// must never throw into the caller — notifications are best-effort.

type FetchFn = typeof fetch;

interface RemoteNotifyPayload {
  title: string;
  body: string;
  // ntfy priority header: "max" | "high" | "default" | "low" | "min".
  priority?: string;
}

interface RemoteNotifyDeps {
  fetch?: FetchFn;
  timeoutMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  log?: (msg: string) => void;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_RETRIES = 2;
const BACKOFF_BASE_MS = 200;
const BACKOFF_JITTER_MS = 100;

// Transient = worth retrying: server errors (5xx) and rate limiting (429).
// Any other non-2xx (e.g. 400/404) is a permanent client error — no retry.
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

function backoffMs(attempt: number, random: () => number): number {
  return (
    BACKOFF_BASE_MS * 2 ** attempt + Math.floor(random() * BACKOFF_JITTER_MS)
  );
}

export async function sendRemoteNotification(
  url: string,
  payload: RemoteNotifyPayload,
  deps: RemoteNotifyDeps = {},
): Promise<boolean> {
  if (!url.startsWith("https://")) {
    deps.log?.("remote notification skipped: URL must be HTTPS");
    return false;
  }

  const doFetch = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = deps.retries ?? DEFAULT_RETRIES;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;

  const headers: Record<string, string> = { Title: payload.title };
  if (payload.priority) headers.Priority = payload.priority;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: "POST",
        body: payload.body,
        headers,
        signal: controller.signal,
      });
      if (res.ok) return true;
      if (!isTransientStatus(res.status)) {
        deps.log?.(`remote notification failed: HTTP ${res.status}`);
        return false;
      }
      // Transient HTTP error — fall through to retry/backoff.
    } catch {
      // Network error or timeout abort — transient, fall through to retry.
    } finally {
      clearTimeout(timer);
    }

    if (attempt < maxRetries) {
      await sleep(backoffMs(attempt, random));
    } else {
      deps.log?.("remote notification failed: retries exhausted");
    }
  }
  return false;
}
