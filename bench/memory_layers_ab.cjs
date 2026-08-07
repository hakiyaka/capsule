"use strict";

// Small deterministic A/B measurement for the layered memory loadout.
// A = every matching memory string; B = Capsule's bounded packet.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-memory-ab-"));
const previousState = process.env.CAPSULE_STATE;
process.env.CAPSULE_STATE = state;
const memory = require("../mcp/memory-layers.cjs");

function percent(before, after) {
  return before > 0 ? Number(((before - after) / before * 100).toFixed(2)) : 0;
}

try {
  const repeated = "Stable verification fact: run the focused regression test before the full suite. ";
  memory.capture({
    items: [
      { layer: "profile", content: "Prefer exact evidence, native edits, and focused verification.", tags: ["policy"], scope: { project: "benchmark" } },
      { layer: "scenario", content: `The active release task is a focused verification test in a bounded memory loadout experiment. ${repeated.repeat(14)}`, tags: ["release"], scope: { project: "benchmark" } },
      { layer: "fact", content: repeated.repeat(42), tags: ["release"], scope: { project: "benchmark" } },
      { layer: "fact", content: `The project uses Node and the focused command is npm test. ${repeated.repeat(28)}`, tags: ["ui"], scope: { project: "benchmark" } },
    ],
  });

  const store = JSON.parse(fs.readFileSync(memory.memoryPaths().store, "utf8"));
  const raw = store.records
    .filter((record) => record.scope?.project === "benchmark")
    .map((record) => record.text || record.preview || "")
    .join("\n");
  const cases = [600, 1_200, 2_400].map((maxChars) => {
    const result = memory.recall({
      query: "focused verification test",
      scope: { project: "benchmark" },
      max_chars: maxChars,
    });
    const visible = result.response.packet.length;
    return {
      max_chars: maxChars,
      a_all_matching_chars: raw.length,
      b_loadout_chars: visible,
      saving_percent: percent(raw.length, visible),
      avoided_tokens_estimate: Math.max(0, Math.ceil((raw.length - visible) / 4)),
      selected_items: result.response.items.length,
    };
  });
  const index = memory.dispatch({
    operation: "index",
    query: "focused verification test",
    scope: { project: "benchmark" },
    max_chars: 420,
  });
  const selectedId = index.response.items[0]?.id || "";
  const recovered = selectedId ? memory.dispatch({ operation: "get", id: selectedId }) : null;
  const progressive = {
    index_chars: index.response.packet.length,
    index_saving_percent: percent(raw.length, index.response.packet.length),
    exact_recovery: Boolean(recovered?.response?.exact && recovered.response.text),
    selected_id: selectedId,
  };
  const releaseRaw = store.records
    .filter((record) => record.scope?.project === "benchmark" && record.tags?.includes("release"))
    .map((record) => record.text || record.preview || "")
    .join("\n");
  const bound = memory.recall({
    query: "focused verification test",
    loadout: { tags: ["release"], scope: { project: "benchmark" }, strict_scope: true },
    max_chars: 600,
  });
  const loadoutBinding = {
    all_scoped_chars: raw.length,
    bound_candidate_chars: releaseRaw.length,
    emitted_chars: bound.response.packet.length,
    pre_ranking_filter_percent: percent(raw.length, releaseRaw.length),
    total_saving_percent: percent(raw.length, bound.response.packet.length),
    selected_items: bound.response.items.length,
    exact_scope: bound.response.loadout.strict_scope,
    filtered_candidates: bound.response.omitted.loadout_filtered,
  };
  const bootstrap = memory.recall({
    query: "focused verification test",
    loadout: { scope: { project: "benchmark" }, strict_scope: true, strategy: "bootstrap" },
    max_chars: 2_400,
  });
  const bootstrapId = bootstrap.response.items[0]?.id || "";
  const bootstrapRecovered = bootstrapId ? memory.get({ id: bootstrapId }) : null;
  const bootstrapRetrieval = {
    stage: bootstrap.response.retrieval.stage,
    candidate_chars: bootstrap.response.budget.candidate_chars,
    emitted_chars: bootstrap.response.packet.length,
    candidate_filter_percent: percent(raw.length, bootstrap.response.budget.candidate_chars),
    total_saving_percent: percent(raw.length, bootstrap.response.packet.length),
    selected_items: bootstrap.response.items.length,
    exact_recovery: Boolean(bootstrapRecovered?.response?.exact),
    filtered_candidates: bootstrap.response.omitted.bootstrap_filtered,
  };
  console.log(JSON.stringify({
    benchmark: "memory-layers-ab",
    method: "A=all scoped memory text; B=query-conditioned L0-L3 loadout; C=pre-ranked release binding; character proxy, not provider billing",
    cases,
    progressive,
    loadout_binding: loadoutBinding,
    bootstrap_retrieval: bootstrapRetrieval,
  }, null, 2));
} finally {
  if (previousState == null) delete process.env.CAPSULE_STATE;
  else process.env.CAPSULE_STATE = previousState;
  fs.rmSync(state, { recursive: true, force: true });
}
