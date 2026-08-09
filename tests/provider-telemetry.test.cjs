"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const telemetry = require("../mcp/provider-telemetry.cjs");

test("provider telemetry reports exact reasoning, context, cache, and limit counters", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-provider-"));
  const session = path.join(root, "session.jsonl");
  const record = {
    timestamp: "2026-07-31T12:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        model_context_window: 100_000,
        last_token_usage: {
          input_tokens: 40_000,
          cached_input_tokens: 30_000,
          output_tokens: 800,
          reasoning_output_tokens: 500,
          total_tokens: 41_300,
        },
        total_token_usage: {
          input_tokens: 90_000,
          cached_input_tokens: 60_000,
          output_tokens: 2_000,
          reasoning_output_tokens: 1_200,
          total_tokens: 93_200,
        },
      },
      rate_limits: {
        primary: { used_percent: 72, window_minutes: 300, resets_at: 123 },
        secondary: { used_percent: 18, window_minutes: 10_080, resets_at: 456 },
      },
    },
  };
  fs.writeFileSync(session, `${JSON.stringify(record)}\n`, "utf8");

  const result = telemetry.snapshot({ session_file: session }).response;
  assert.equal(result.available, true);
  assert.equal(result.exact_provider_counters, true);
  assert.equal(Object.hasOwn(result, "session_file"), false);
  assert.equal(Object.hasOwn(result, "session_id"), false);
  assert.equal(result.last_request.reasoning_output_tokens, 500);
  assert.equal(result.last_request.uncached_input_tokens, 10_000);
  assert.equal(result.last_request.cache_hit_percent, 75);
  assert.equal(result.context.used_percent, 40);
  assert.equal(result.limits.primary.used_percent, 72);
  assert.equal(result.limits.secondary.window_minutes, 10_080);

  const verbose = telemetry.snapshot({ session_file: session, session: "fixture-session", include_identity: true }).response;
  assert.equal(verbose.session_file, path.resolve(session));
  assert.equal(verbose.session_id, "fixture-session");
});
