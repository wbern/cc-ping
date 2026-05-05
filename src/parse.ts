import type { ClaudeJsonResponse } from "./types.js";

function asString(x: unknown): string {
  return typeof x === "string" ? x : "";
}

function asNumber(x: unknown): number {
  return typeof x === "number" ? x : 0;
}

function asBool(x: unknown): boolean {
  return typeof x === "boolean" ? x : false;
}

export function parseClaudeResponse(stdout: string): ClaudeJsonResponse | null {
  if (!stdout) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const raw = parsed as Record<string, unknown>;

  if (raw.type !== "result") return null;
  if (!raw.usage || typeof raw.usage !== "object") return null;

  const usage = raw.usage as Record<string, unknown>;
  const modelUsage = (raw.modelUsage ?? raw.model_usage) as
    | Record<string, unknown>
    | undefined;
  const model = modelUsage
    ? (Object.keys(modelUsage)[0] ?? "unknown")
    : "unknown";

  return {
    type: "result",
    subtype: asString(raw.subtype),
    session_id: asString(raw.session_id),
    duration_ms: asNumber(raw.duration_ms),
    duration_api_ms: asNumber(raw.duration_api_ms),
    is_error: asBool(raw.is_error),
    num_turns: asNumber(raw.num_turns),
    result: asString(raw.result),
    total_cost_usd: asNumber(raw.total_cost_usd),
    usage: {
      input_tokens: asNumber(usage.input_tokens),
      output_tokens: asNumber(usage.output_tokens),
      cache_read_input_tokens: asNumber(usage.cache_read_input_tokens),
      cache_creation_input_tokens: asNumber(usage.cache_creation_input_tokens),
    },
    model,
  };
}
