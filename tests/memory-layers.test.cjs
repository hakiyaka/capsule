"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const previousState = process.env.CAPSULE_STATE;
const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-memory-layers-"));
process.env.CAPSULE_STATE = state;

const memory = require("../mcp/memory-layers.cjs");
const schema = require("../mcp/schema.cjs");
const unified = require("../mcp/unified.cjs");

test.after(() => {
  if (previousState == null) delete process.env.CAPSULE_STATE;
  else process.env.CAPSULE_STATE = previousState;
  fs.rmSync(state, { recursive: true, force: true });
});

test("layered capture is explicit, idempotent, redacted, and trace-safe by default", () => {
  const first = memory.capture({
    items: [
      {
        layer: "profile",
        content: "Prefer exact evidence and concise output for this project.",
        scope: { project: "fixture" },
      },
      {
        layer: "fact",
        content: `The verification command is npm test. ${"Stable fact. ".repeat(80)}`,
        scope: { project: "fixture" },
      },
      {
        layer: "trace",
        content: "authorization: Bearer super-secret-value; raw transcript is not needed.",
        scope: { project: "fixture" },
      },
    ],
  });
  assert.equal(first.response.items.length, 3);
  assert.equal(first.response.raw_retained, false);

  const duplicate = memory.capture({
    layer: "fact",
    content: `The verification command is npm test. ${"Stable fact. ".repeat(80)}`,
    scope: { project: "fixture" },
  });
  assert.equal(duplicate.response.items[0].deduplicated, true);

  const status = memory.status().response;
  assert.deepEqual(status.counts, { trace: 1, fact: 1, scenario: 0, profile: 1 });
  assert.equal(status.hidden_trace_digests, 1);
  const loaded = JSON.parse(fs.readFileSync(memory.memoryPaths().store, "utf8"));
  assert.ok(loaded.records.every((record) => !recordText(record).includes("super-secret-value")));
});

function recordText(record) {
  return `${record.text || ""} ${record.preview || ""}`;
}

test("recall emits a query-conditioned loadout under a hard character budget", () => {
  const operation = memory.recall({
    query: "verification command",
    scope: { project: "fixture" },
    max_chars: 260,
  });
  assert.equal(operation.route, "memory-layer-loadout");
  assert.ok(operation.response.packet.length <= 260);
  assert.match(operation.response.packet, /npm test/);
  assert.doesNotMatch(operation.response.packet, /super-secret-value/);
  assert.ok(operation.response.budget.estimated_avoided_tokens > 0);
  assert.equal(operation.response.omitted.hidden_trace_without_retain_raw, 1);
});

test("progressive memory index returns compact IDs and get recovers one exact record", () => {
  memory.capture({
    layer: "fact",
    content: `Progressive memory keeps the complete verification procedure available. ${"Exact evidence. ".repeat(20)}`,
    scope: { project: "progressive" },
  });
  const indexed = memory.dispatch({
    operation: "index",
    query: "verification procedure",
    scope: { project: "progressive" },
    max_chars: 260,
  });
  assert.equal(indexed.route, "memory-layer-index");
  assert.ok(indexed.response.packet.length <= 260);
  assert.equal(indexed.response.items.length, 1);
  assert.ok(indexed.response.items[0].id.startsWith("mem_"));
  assert.ok(indexed.response.budget.estimated_avoided_tokens > 0);

  const recovered = memory.dispatch({ operation: "get", id: indexed.response.items[0].id });
  assert.equal(recovered.route, "memory-layer-get");
  assert.equal(recovered.response.exact, true);
  assert.match(recovered.response.text, /complete verification procedure/);
  assert.match(recovered.response.text, /Exact evidence/);
});

test("loadout bindings filter irrelevant assets before ranking and preserve exact recovery", () => {
  memory.capture({
    items: [
      {
        layer: "scenario",
        content: "Deployment evidence for the release procedure is the focused CI result.",
        tags: ["release", "ci"],
        source: "explicit",
        scope: { project: "loadout" },
      },
      {
        layer: "fact",
        content: "Deployment evidence for the visual procedure belongs to the unrelated UI lane.",
        tags: ["ui"],
        source: "explicit",
        scope: { project: "loadout" },
      },
      {
        layer: "fact",
        content: "Deployment evidence for the release procedure came from an untrusted import.",
        tags: ["release"],
        source: "import",
        scope: { project: "loadout" },
      },
      {
        layer: "fact",
        content: "Deployment evidence from a global unscoped note must not cross a strict project binding.",
        tags: ["release"],
        source: "explicit",
      },
    ],
  });
  const binding = {
    tags: ["release"],
    sources: ["explicit"],
    scope: { project: "loadout" },
    strict_scope: true,
  };
  const recalled = memory.recall({
    query: "deployment evidence procedure",
    loadout: binding,
    max_chars: 600,
  });
  assert.equal(recalled.response.loadout.applied, true);
  assert.equal(recalled.response.loadout.strict_scope, true);
  assert.ok(recalled.response.omitted.loadout_filtered >= 3);
  assert.equal(recalled.response.items.length, 1);
  assert.deepEqual(recalled.response.items[0].tags, ["release", "ci"]);

  const indexed = memory.index({
    query: "deployment evidence procedure",
    binding: { ...binding, asset_types: ["scenario"] },
    max_chars: 260,
  });
  assert.equal(indexed.response.items.length, 1);
  assert.equal(indexed.response.items[0].id, recalled.response.items[0].id);
  const recovered = memory.get({ id: indexed.response.items[0].id });
  assert.equal(recovered.response.exact, true);
  assert.match(recovered.response.text, /focused CI result/);
});

test("bootstrap retrieval prefers high-level memory and falls back when needed", () => {
  memory.capture({
    items: [
      {
        layer: "scenario",
        content: "zircon bootstrap release context is ready for the next task.",
        scope: { project: "bootstrap" },
      },
      {
        layer: "fact",
        content: "zircon bootstrap release fact contains a lower-level detail.",
        scope: { project: "bootstrap" },
      },
      {
        layer: "trace",
        content: "zircon bootstrap release raw trace is retained only as a preview.",
        scope: { project: "bootstrap" },
      },
      {
        layer: "fact",
        content: "fallback-only-kappa fact exists only in the lower evidence lane.",
        scope: { project: "bootstrap" },
      },
    ],
  });
  const loadout = { scope: { project: "bootstrap" }, strict_scope: true, strategy: "bootstrap" };
  const preferred = memory.recall({ query: "zircon bootstrap release", loadout, max_chars: 800 });
  assert.equal(preferred.response.retrieval.stage, "profile-scenario");
  assert.equal(preferred.response.items.length, 1);
  assert.equal(preferred.response.items[0].layer, "scenario");
  assert.equal(preferred.response.omitted.bootstrap_filtered, 2);

  const fallback = memory.recall({ query: "fallback-only-kappa", loadout, max_chars: 800 });
  assert.equal(fallback.response.retrieval.stage, "fallback-all");
  assert.equal(fallback.response.items.length, 1);
  assert.equal(fallback.response.items[0].layer, "fact");

  const indexed = memory.index({ query: "zircon bootstrap release", loadout, max_chars: 260 });
  assert.equal(indexed.response.retrieval.stage, "profile-scenario");
  assert.equal(indexed.response.items.length, 1);
  assert.equal(indexed.response.items[0].layer, "scenario");
});

test("scope, promotion, and expiry stay isolated and pruning is auditable", () => {
  const other = memory.capture({
    layer: "scenario",
    content: "A different project must never enter the fixture loadout.",
    scope: { project: "other" },
  });
  const id = other.response.items[0].id;
  const promoted = memory.promote({ id, to: "profile" });
  assert.equal(promoted.response.to, "profile");
  const isolated = memory.recall({ query: "different project", scope: { project: "fixture" }, max_chars: 800 });
  assert.equal(isolated.response.items.some((item) => item.id === id), false);

  memory.capture({
    layer: "scenario",
    content: "This expires immediately.",
    scope: { project: "fixture" },
    expires_at: new Date(Date.now() - 1_000).toISOString(),
  });
  const preview = memory.prune({ dry_run: true });
  assert.equal(preview.response.dry_run, true);
  assert.ok(preview.response.expired >= 1);
  const applied = memory.prune({ dry_run: false });
  assert.equal(applied.response.dry_run, false);
  assert.ok(applied.response.removed >= 1);
});

test("the unified Capsule surface exposes the memory action", async () => {
  assert.ok(schema.actions.includes("memory"));
  const operation = await unified.dispatch({
    action: "memory",
    payload: { operation: "status" },
  });
  assert.equal(operation.response.operation, "status");
  assert.equal(operation.response.route, "memory-layer-status");
});
