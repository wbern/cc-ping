import { describe, expect, it } from "vitest";
import { parseClaudeResponse } from "./parse.js";

function makeResponse(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    session_id: "abc-123",
    duration_ms: 1500,
    duration_api_ms: 1200,
    is_error: false,
    num_turns: 1,
    result: "pong",
    total_cost_usd: 0.003,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    model_usage: {
      "claude-sonnet-4-20250514": {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
    ...overrides,
  });
}

describe("parseClaudeResponse", () => {
  it("parses a valid success response", () => {
    const result = parseClaudeResponse(makeResponse());
    expect(result).not.toBeNull();
    expect(result!.type).toBe("result");
    expect(result!.subtype).toBe("success");
    expect(result!.session_id).toBe("abc-123");
    expect(result!.duration_ms).toBe(1500);
    expect(result!.duration_api_ms).toBe(1200);
    expect(result!.is_error).toBe(false);
    expect(result!.num_turns).toBe(1);
    expect(result!.result).toBe("pong");
    expect(result!.total_cost_usd).toBe(0.003);
    expect(result!.usage.input_tokens).toBe(10);
    expect(result!.usage.output_tokens).toBe(5);
    expect(result!.model).toBe("claude-sonnet-4-20250514");
  });

  it("parses a valid error response", () => {
    const result = parseClaudeResponse(
      makeResponse({ is_error: true, subtype: "error_max_turns" }),
    );
    expect(result).not.toBeNull();
    expect(result!.is_error).toBe(true);
    expect(result!.subtype).toBe("error_max_turns");
  });

  it("returns null for empty string", () => {
    expect(parseClaudeResponse("")).toBeNull();
  });

  it("returns null for non-JSON string", () => {
    expect(parseClaudeResponse("not json at all")).toBeNull();
  });

  it("returns null when JSON parses to null", () => {
    expect(parseClaudeResponse("null")).toBeNull();
  });

  it("returns null when JSON parses to a scalar", () => {
    expect(parseClaudeResponse("42")).toBeNull();
  });

  it("returns null when JSON parses to an array", () => {
    expect(parseClaudeResponse("[1,2,3]")).toBeNull();
  });

  it("returns null for JSON missing type field", () => {
    const json = JSON.stringify({ subtype: "success", usage: {} });
    expect(parseClaudeResponse(json)).toBeNull();
  });

  it("returns null for JSON with wrong type", () => {
    const json = makeResponse({ type: "message" });
    expect(parseClaudeResponse(json)).toBeNull();
  });

  it("returns null for JSON missing usage object", () => {
    const raw = JSON.parse(makeResponse());
    delete raw.usage;
    expect(parseClaudeResponse(JSON.stringify(raw))).toBeNull();
  });

  it("parses response with zero cost and tokens", () => {
    const result = parseClaudeResponse(
      makeResponse({
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.total_cost_usd).toBe(0);
    expect(result!.usage.input_tokens).toBe(0);
    expect(result!.usage.output_tokens).toBe(0);
  });

  it("falls back to unknown model when modelUsage is missing", () => {
    const raw = JSON.parse(makeResponse());
    delete raw.model_usage;
    delete raw.modelUsage;
    const result = parseClaudeResponse(JSON.stringify(raw));
    expect(result).not.toBeNull();
    expect(result!.model).toBe("unknown");
  });

  it("extracts model from camelCase modelUsage", () => {
    const raw = JSON.parse(makeResponse());
    delete raw.model_usage;
    raw.modelUsage = { "claude-opus-4-6": {} };
    const result = parseClaudeResponse(JSON.stringify(raw));
    expect(result).not.toBeNull();
    expect(result!.model).toBe("claude-opus-4-6");
  });

  it("defaults missing numeric fields to 0", () => {
    const raw = JSON.parse(makeResponse());
    delete raw.duration_ms;
    delete raw.duration_api_ms;
    delete raw.num_turns;
    delete raw.total_cost_usd;
    const result = parseClaudeResponse(JSON.stringify(raw));
    expect(result).not.toBeNull();
    expect(result!.duration_ms).toBe(0);
    expect(result!.duration_api_ms).toBe(0);
    expect(result!.num_turns).toBe(0);
    expect(result!.total_cost_usd).toBe(0);
  });

  it("defaults missing string and boolean fields", () => {
    const raw = JSON.parse(makeResponse());
    delete raw.subtype;
    delete raw.session_id;
    delete raw.is_error;
    delete raw.result;
    const result = parseClaudeResponse(JSON.stringify(raw));
    expect(result).not.toBeNull();
    expect(result!.subtype).toBe("");
    expect(result!.session_id).toBe("");
    expect(result!.is_error).toBe(false);
    expect(result!.result).toBe("");
  });

  it("defaults missing usage sub-fields to 0", () => {
    const result = parseClaudeResponse(makeResponse({ usage: {} }));
    expect(result).not.toBeNull();
    expect(result!.usage.input_tokens).toBe(0);
    expect(result!.usage.output_tokens).toBe(0);
    expect(result!.usage.cache_read_input_tokens).toBe(0);
    expect(result!.usage.cache_creation_input_tokens).toBe(0);
  });

  it("falls back to unknown when modelUsage has empty keys", () => {
    const result = parseClaudeResponse(
      makeResponse({ model_usage: undefined, modelUsage: {} }),
    );
    expect(result).not.toBeNull();
    expect(result!.model).toBe("unknown");
  });
});
