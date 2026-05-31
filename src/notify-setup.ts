import { randomUUID } from "node:crypto";

// Default public ntfy server. Topics are created on the fly by subscribing or
// publishing — no signup — and the topic string is the only credential, so a
// generated topic uses a UUID (122 bits) to stay un-guessable.
export const DEFAULT_NTFY_SERVER = "https://ntfy.sh";

export function generateTopic(
  genId: () => string = () => randomUUID(),
): string {
  return `cc-ping-${genId()}`;
}

export function buildNotifyUrl(
  topic: string,
  server: string = DEFAULT_NTFY_SERVER,
): string {
  const base = server.replace(/\/+$/, "");
  const url = `${base}/${topic}`;
  if (!url.startsWith("https://")) {
    throw new Error("Notification server must be HTTPS");
  }
  return url;
}
