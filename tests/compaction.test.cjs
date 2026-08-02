"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const compaction = require("../mcp/compaction.cjs");

function usage(
  input,
  cached,
  output,
  reasoning,
  totalInput,
  totalOutput,
  totalReasoning,
  contextWindow = 258_400,
  rateLimits = null
) {
  return {
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        model_context_window: contextWindow,
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: output,
          reasoning_output_tokens: reasoning,
          total_tokens: input + output,
        },
        total_token_usage: {
          input_tokens: totalInput,
          cached_input_tokens: 0,
          output_tokens: totalOutput,
          reasoning_output_tokens: totalReasoning,
          total_tokens: totalInput + totalOutput,
        },
      },
      ...(rateLimits ? { rate_limits: rateLimits } : {}),
    },
  };
}

function writeJsonl(file, records) {
  fs.writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

test("context pressure detects high occupancy, compaction thrash, and retained images", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-context-pressure-"));
  const file = path.join(root, "rollout.jsonl");
  try {
    writeJsonl(file, [
      usage(92_000, 80_000, 200, 50, 100_000, 1_000, 200, 100_000),
      {
        timestamp: new Date().toISOString(),
        type: "compacted",
        payload: {
          window_number: 1,
          replacement_history: [{
            role: "user",
            content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
          }],
        },
      },
      usage(72_000, 60_000, 100, 20, 172_000, 1_100, 220, 100_000),
      usage(85_000, 70_000, 120, 30, 257_000, 1_220, 250, 100_000),
    ]);

    const result = compaction.contextPressure({ session_file: file }).response;
    assert.equal(result.available, true);
    assert.equal(result.input_tokens, 85_000);
    assert.equal(result.context_window, 100_000);
    assert.equal(result.used_percent, 85);
    assert.equal(result.cached_input_tokens, 70_000);
    assert.equal(result.uncached_input_tokens, 15_000);
    assert.equal(result.cache_hit_percent, 82.35);
    assert.equal(result.roundtrip_tax.telemetry_available, true);
    assert.equal(result.roundtrip_tax.elevated, true);
    assert.equal(result.recent_compactions, 1);
    assert.equal(result.last_post_compaction_percent, 72);
    assert.equal(result.retained_image_items, 1);
    assert.equal(result.mode, "emergency");
    assert.equal(result.policy.summary_tokens, 280);
    assert.equal(result.policy.seed_chars, 720);
    assert.equal(result.policy.tool_trigger_chars, 900);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("context pressure predicts runway and escalates before context or quota exhaustion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-predictive-pressure-"));
  const runwayFile = path.join(root, "runway.jsonl");
  const quotaFile = path.join(root, "quota.jsonl");
  try {
    writeJsonl(runwayFile, [
      usage(43_000, 30_000, 100, 20, 43_000, 100, 20, 100_000),
      usage(59_000, 45_000, 100, 20, 102_000, 200, 40, 100_000),
      usage(75_000, 60_000, 100, 20, 177_000, 300, 60, 100_000),
    ]);
    const runway = compaction.contextPressure({ session_file: runwayFile }).response;
    assert.equal(runway.used_percent, 75);
    assert.equal(runway.mode, "critical");
    assert.equal(runway.growth_tokens_per_observation, 16_000);
    assert.equal(runway.projected_next_percent, 91);
    assert.equal(runway.observations_to_90_percent, 1);
    assert.match(runway.reasons.join(" "), /runway|projected/i);

    writeJsonl(quotaFile, [
      usage(20_000, 15_000, 100, 20, 20_000, 100, 20, 100_000, {
        primary: { used_percent: 96, window_minutes: 10_080, resets_at: 1_900_000_000 },
        rate_limit_reached_type: null,
      }),
    ]);
    const quota = compaction.contextPressure({ session_file: quotaFile }).response;
    assert.equal(quota.used_percent, 20);
    assert.equal(quota.quota.used_percent, 96);
    assert.equal(quota.quota.window_minutes, 10_080);
    assert.equal(quota.mode, "emergency");
    assert.match(quota.reasons.join(" "), /quota/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("large compaction replacement history tightens the next-turn policy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-replacement-pressure-"));
  const file = path.join(root, "replacement.jsonl");
  try {
    writeJsonl(file, [
      usage(20_000, 19_000, 100, 20, 20_000, 100, 20, 200_000),
      {
        timestamp: new Date().toISOString(),
        type: "compacted",
        payload: {
          window_number: 1,
          replacement_history: [{ role: "assistant", content: "x".repeat(200_000) }],
        },
      },
      usage(22_000, 21_000, 100, 20, 42_000, 200, 40, 200_000),
    ]);
    const result = compaction.contextPressure({ session_file: file }).response;
    assert.ok(result.latest_replacement_history_chars >= 200_000);
    assert.ok(result.recent_replacement_history_chars >= 200_000);
    assert.equal(result.latest_replacement_history_items, 1);
    assert.equal(result.mode, "high");
    assert.equal(result.policy.tool_trigger_chars, 3_000);
    assert.match(result.reasons.join(" "), /replacement history/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("context pressure mechanically tightens budgets when the uncached suffix is costly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-roundtrip-pressure-"));
  const taxedFile = path.join(root, "taxed.jsonl");
  const healthyFile = path.join(root, "healthy.jsonl");
  const missingFile = path.join(root, "missing.jsonl");
  try {
    writeJsonl(taxedFile, [
      usage(80_000, 55_000, 100, 20, 80_000, 100, 20, 200_000),
    ]);
    writeJsonl(healthyFile, [
      usage(80_000, 77_000, 100, 20, 80_000, 100, 20, 200_000),
    ]);
    const missing = usage(80_000, 0, 100, 20, 80_000, 100, 20, 200_000);
    delete missing.payload.info.last_token_usage.cached_input_tokens;
    writeJsonl(missingFile, [missing]);
    const taxed = compaction.contextPressure({ session_file: taxedFile }).response;
    const healthy = compaction.contextPressure({ session_file: healthyFile }).response;
    const unavailable = compaction.contextPressure({ session_file: missingFile }).response;
    assert.equal(taxed.roundtrip_tax.elevated, true);
    assert.equal(taxed.mode, "critical");
    assert.match(taxed.reasons.join(" "), /uncached round-trip suffix/i);
    assert.equal(taxed.policy.tool_trigger_chars, 1_400);
    assert.equal(healthy.roundtrip_tax.elevated, false);
    assert.equal(healthy.mode, "normal");
    assert.equal(healthy.policy.tool_trigger_chars, 5_000);
    assert.equal(unavailable.roundtrip_tax.telemetry_available, false);
    assert.equal(unavailable.roundtrip_tax.uncached_input_tokens, 0);
    assert.equal(unavailable.mode, "normal");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("context pressure classifies abrupt and post-compaction cache misses", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-cache-incident-"));
  const abruptFile = path.join(root, "abrupt.jsonl");
  const compactedFile = path.join(root, "compacted.jsonl");
  try {
    writeJsonl(abruptFile, [
      usage(60_000, 58_000, 100, 20, 60_000, 100, 20, 200_000),
      usage(64_000, 0, 100, 20, 124_000, 200, 40, 200_000),
    ]);
    writeJsonl(compactedFile, [
      usage(80_000, 76_000, 100, 20, 80_000, 100, 20, 200_000),
      {
        timestamp: new Date().toISOString(),
        type: "compacted",
        payload: { replacement_history: [] },
      },
      usage(50_000, 0, 100, 20, 130_000, 200, 40, 200_000),
    ]);
    const abrupt = compaction.contextPressure({ session_file: abruptFile }).response;
    const compacted = compaction.contextPressure({ session_file: compactedFile }).response;
    assert.equal(abrupt.roundtrip_tax.cache_incident.detected, true);
    assert.equal(abrupt.roundtrip_tax.cache_incident.classification, "mid-loop-cache-dropout");
    assert.equal(abrupt.roundtrip_tax.cache_incident.previous_cache_hit_percent, 96.67);
    assert.equal(compacted.roundtrip_tax.cache_incident.detected, true);
    assert.equal(compacted.roundtrip_tax.cache_incident.classification, "post-compaction-cache-miss");
    assert.equal(compacted.roundtrip_tax.cache_incident.input_delta, -30_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("context pressure reports input shrink without attributing provider cause", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-cache-shrink-"));
  const file = path.join(root, "shrink.jsonl");
  try {
    writeJsonl(file, [
      usage(80_000, 76_000, 100, 20, 80_000, 100, 20, 200_000),
      usage(50_000, 30_000, 100, 20, 130_000, 200, 40, 200_000),
    ]);
    const pressure = compaction.contextPressure({ session_file: file }).response;
    assert.equal(pressure.roundtrip_tax.cache_incident.classification, "request-input-shrank");
    assert.match(pressure.caveat, /cannot prove a provider-side cause/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("compaction audit separates unreported generation cost from observable next-call context", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-compaction-audit-"));
  const file = path.join(root, "rollout.jsonl");
  try {
    writeJsonl(file, [
      usage(100_000, 90_000, 200, 80, 500_000, 2_000, 600),
      {
        timestamp: new Date().toISOString(),
        type: "compacted",
        payload: {
          window_number: 1,
          replacement_history: [
            { type: "compaction", encrypted_content: "x".repeat(2_000) },
            { role: "user", content: "critical instruction" },
          ],
        },
      },
      usage(0, 0, 0, 0, 500_000, 2_000, 600),
      usage(12_000, 8_000, 120, 30, 512_000, 2_120, 630),
      usage(120_000, 110_000, 220, 90, 900_000, 4_000, 1_200),
      {
        timestamp: new Date().toISOString(),
        type: "compacted",
        payload: {
          window_number: 2,
          replacement_history: [{ type: "compaction", encrypted_content: "y".repeat(4_000) }],
        },
      },
      usage(0, 0, 0, 0, 900_000, 4_000, 1_200),
      usage(15_000, 10_000, 150, 40, 915_000, 4_150, 1_240),
    ]);

    const result = compaction.auditSession({ session_file: file }).response;
    assert.equal(result.available, true);
    assert.equal(result.compactions, 2);
    assert.equal(result.direct_compaction_tokens.reported_delta, 0);
    assert.equal(result.direct_compaction_tokens.adjacent_counter_observations, 2);
    assert.equal(result.direct_compaction_tokens.exposed_by_telemetry, false);
    assert.equal(result.observable_context.pre_input_tokens.average, 110_000);
    assert.equal(result.observable_context.post_input_tokens.average, 13_500);
    assert.equal(result.observable_context.post_cached_input_tokens.average, 9_000);
    assert.equal(result.observable_context.post_uncached_input_tokens.average, 4_500);
    assert.equal(result.observable_context.reduction_percent, 87.73);
    assert.equal(result.events.length, 2);
    assert.ok(result.events[0].replacement_history_chars > 2_000);
    assert.match(result.caveat, /does not expose|not exposed|göster/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("compaction seed preserves continuation facts in a strict bounded dictionary", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-compaction-seed-"));
  const file = path.join(root, "rollout.jsonl");
  const changed = path.join(root, "src", "engine.cjs");
  try {
    writeJsonl(file, [
      {
        timestamp: new Date().toISOString(),
        type: "compacted",
        payload: { window_number: 1, replacement_history: [] },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Goal NEBULA-417. Do not browse. Keep compatibility with every skill. Capsule limits reasoning-token growth. Secret token=do-not-leak.",
        },
      },
      {
        timestamp: new Date().toISOString(),
        type: "compacted",
        payload: { window_number: 2, replacement_history: [] },
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        type: "response_item",
        payload: {
          type: "custom_tool_call_output",
          output: `repeated noisy log ${index} ${"noise ".repeat(100)}`,
        },
      })),
      {
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          success: true,
          changes: { [changed]: { type: "update" } },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "agent_message",
          phase: "commentary",
          message: "Tests 7/7 pass. Remaining blocker: validate restart. Exact capsule cap_0123456789abcdef.",
        },
      },
    ]);

    const result = compaction.buildSeed({ session_file: file, max_chars: 900 }).response;
    assert.equal(result.available, true);
    assert.ok(result.context.length <= 900);
    assert.match(result.context, /NEBULA-417/);
    assert.match(result.context, /Do not browse/);
    assert.match(result.context, /Capsule limits reasoning-token growth/);
    assert.match(result.context, /engine\.cjs/);
    assert.match(result.context, /7\/7 pass/);
    assert.match(result.context, /validate restart/);
    assert.match(result.context, /cap_0123456789abcdef/);
    assert.doesNotMatch(result.context, /do-not-leak/);
    assert.doesNotMatch(result.context, /repeated noisy log/);
    assert.match(result.context, /<=600 tokens|summary<=600/i);
    assert.match(result.context, /system\/developer\/AGENTS\/skills\/memory\/app-context/);
    assert.match(result.context, /Codex reinjects/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("compaction seed uses field budgets so long prose cannot evict files and capsules", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-compaction-budget-"));
  const file = path.join(root, "rollout.jsonl");
  const changed = path.join(root, "src", "critical-engine.cjs");
  try {
    writeJsonl(file, [
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: `Goal ORBIT-991 ${"long objective detail ".repeat(100)}`,
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "patch_apply_end",
          changes: { [changed]: { type: "update" } },
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: `State VERIFIED-22 ${"long implementation state ".repeat(100)} Exact capsule cap_aaaaaaaaaaaaaaaa.`,
        },
      },
    ]);

    const result = compaction.buildSeed({ session_file: file, max_chars: 720 }).response;
    assert.ok(result.context.length <= 720);
    assert.match(result.context, /ORBIT-991/);
    assert.match(result.context, /VERIFIED-22/);
    assert.match(result.context, /critical-engine\.cjs/);
    assert.match(result.context, /cap_aaaaaaaaaaaaaaaa/);
    assert.match(result.context, /summary<=600/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("compaction seed carries one bounded prior phase under adaptive summary targets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-compaction-history-"));
  const file = path.join(root, "rollout.jsonl");
  try {
    writeJsonl(file, [{
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Current state CURRENT-88. Tests 9/9 pass.",
      },
    }]);
    const result = compaction.buildSeed({
      session_file: file,
      historical: "Prior phase PHASE-17 selected the content-hash cache key.",
      progress: "epoch=3; inspected=router.tsx3,cache.test.ts; changed=router.ts; tests=npm test pass; next=run fuzz",
      max_chars: 720,
      summary_tokens: 280,
    }).response;
    assert.ok(result.context.length <= 720);
    assert.match(result.context, /summary<=280/);
    assert.match(result.context, /CURRENT-88/);
    assert.match(result.context, /PHASE-17/);
    assert.match(result.context, /content-hash cache key/);
    assert.match(result.context, /epoch=3/);
    assert.match(result.context, /router\.ts/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
