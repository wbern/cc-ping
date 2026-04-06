import type { ClaudeJsonResponse } from "./types.js";

export function parseClaudeResponse(stdout: string): ClaudeJsonResponse | null {
  if (!stdout) return null;

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (raw.type !== "result") return null;
  if (!raw.usage || typeof raw.usage !== "object") return null;

  const usage = raw.usage as Record<string, number>;
  const modelUsage = (raw.modelUsage ?? raw.model_usage) as
    | Record<string, unknown>
    | undefined;
  const model = modelUsage
    ? (Object.keys(modelUsage)[0] ?? "unknown")
    : "unknown";

  return {
    type: raw.type as string,
    subtype: (raw.subtype as string) ?? "",
    session_id: (raw.session_id as string) ?? "",
    duration_ms: (raw.duration_ms as number) ?? 0,
    duration_api_ms: (raw.duration_api_ms as number) ?? 0,
    is_error: (raw.is_error as boolean) ?? false,
    num_turns: (raw.num_turns as number) ?? 0,
    result: (raw.result as string) ?? "",
    total_cost_usd: (raw.total_cost_usd as number) ?? 0,
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    },
    model,
  };
}
