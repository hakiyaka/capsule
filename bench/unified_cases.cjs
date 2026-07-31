"use strict";

const fs = require("node:fs");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const benchmarkState = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-unified-ab-"));
process.env.CAPSULE_STATE = benchmarkState;
const unified = require("../mcp/unified.cjs");
const core = require("../mcp/core.cjs");
const schema = require("../mcp/schema.cjs");

const original = JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "cases.cjs")], {
  encoding: "utf8",
  maxBuffer: 128 * 1024 * 1024,
}));

function profileFor(testCase) {
  if (testCase.category === "logs") return "log";
  if (testCase.category === "command" && /test/i.test(testCase.name)) return "test";
  if (testCase.category === "structured-text" && /json/i.test(testCase.name)) return "network";
  return "generic";
}

const cases = original.cases.map((testCase) => {
  if (testCase.selection === "not-applicable") {
    return { ...testCase, treatment: testCase.baseline, invoked: false };
  }

  const compact = unified.compressText(testCase.baseline, {
    profile: profileFor(testCase),
    query: testCase.query,
    max_chars: original.evidence_budget_chars,
    passthrough_chars: original.policy_threshold_chars,
  });
  const choices = [];
  if (testCase.invoked) {
    choices.push({
      treatment: testCase.treatment,
      route: `unified:reversible-core:${testCase.route}`,
    });
  }
  if (compact.route === "compressed") {
    choices.push({
      treatment: JSON.stringify({
        route: compact.route,
        profile: compact.profile,
        capsule_id: "cap_content_addressed",
        exact_expand: true,
        original_chars: compact.raw_chars,
        output: compact.output,
      }),
      route: `unified:${compact.route}:${compact.profile}`,
    });
  }
  if (!choices.length) {
    return {
      ...testCase,
      treatment: testCase.baseline,
      route: "unified:passthrough",
      invoked: false,
      selection: "measured-safe-bypass",
    };
  }
  choices.sort((a, b) => core.estimateTokens(a.treatment) - core.estimateTokens(b.treatment));
  const best = choices[0];
  return {
    ...testCase,
    treatment: best.treatment,
    route: best.route,
    invoked: true,
    selection: "measured-transform",
  };
});

function addIndexedCase({ name, category, prompt, source, text, query, expected }) {
  unified.indexContent({ content: text, source, title: name, kind: category });
  const searched = unified.searchIndex({ query, limit: 3, kind: category });
  const treatment = JSON.stringify(searched.response);
  const missing = expected.filter((needle) => !treatment.includes(needle));
  if (missing.length) throw new Error(`Indexed benchmark lost evidence for ${name}: ${missing.join(", ")}`);
  cases.push({
    name,
    category,
    prompt,
    query,
    baseline: text,
    treatment,
    route: "unified:persistent-search",
    invoked: true,
    expected,
    selection: "measured-transform",
  });
}

const indexedCorpus = Array.from(
  { length: 18_000 },
  (_, index) => index === 14_321
    ? "DECISION INDEXED-COBALT-LANE requires verification before deployment"
    : `routine architecture record ${index}: no material change`
).join("\n");
addIndexedCase({
  name: "persistent-index-first-query",
  category: "persistent-index",
  prompt: "Find the deployment lane decision in the indexed architecture corpus.",
  source: "memory://benchmark/architecture",
  text: indexedCorpus,
  query: "INDEXED-COBALT-LANE deployment",
  expected: ["INDEXED-COBALT-LANE"],
});
addIndexedCase({
  name: "persistent-index-repeat-query",
  category: "persistent-index",
  prompt: "Recall the same deployment decision without reloading the corpus.",
  source: "memory://benchmark/architecture",
  text: indexedCorpus,
  query: "COBALT-LANE verification",
  expected: ["INDEXED-COBALT-LANE"],
});

const fetchedCorpus = Array.from(
  { length: 12_000 },
  (_, index) => index === 9_876
    ? '<section id="policy">FETCHED-POLICY-NEEDLE retention=30-days</section>'
    : `<div data-row="${index}">routine fetched page content</div>`
).join("\n");
addIndexedCase({
  name: "fetch-index-query",
  category: "fetch-index",
  prompt: "Find the retention rule without returning the full fetched page.",
  source: "https://example.invalid/benchmark-policy",
  text: fetchedCorpus,
  query: "FETCHED-POLICY-NEEDLE retention",
  expected: ["FETCHED-POLICY-NEEDLE"],
});

const memoryCorpus = Array.from(
  { length: 9_000 },
  (_, index) => index === 7_000
    ? "HANDOFF-MEMORY-NEEDLE: migration paused on checksum mismatch"
    : `session event ${index}: routine progress`
).join("\n");
addIndexedCase({
  name: "persistent-memory-recall",
  category: "persistent-memory",
  prompt: "Recall the migration blocker from durable local memory.",
  source: "memory://benchmark/handoff",
  text: memoryCorpus,
  query: "HANDOFF-MEMORY-NEEDLE checksum",
  expected: ["HANDOFF-MEMORY-NEEDLE"],
});

const historyHome = path.join(benchmarkState, "codex-home");
const historySessions = path.join(historyHome, "sessions", "2026", "07", "27");
fs.mkdirSync(historySessions, { recursive: true });
const historySecret = "HISTORY-CONTENT-MUST-STAY-UNREAD";
const historyFiles = [];
const historyLine = (id, parent = null) => JSON.stringify({
  timestamp: "2026-07-27T00:00:00.000Z",
  type: "session_meta",
  payload: {
    id,
    source: parent ? { subagent: { thread_spawn: {} } } : "vscode",
    parent_thread_id: parent,
  },
});
const writeHistoryFile = (name, line, body) => {
  const target = path.join(historySessions, name);
  fs.writeFileSync(target, `${line}\n${body}\n`, "utf8");
  historyFiles.push(fs.readFileSync(target, "utf8"));
};
writeHistoryFile("root.jsonl", historyLine("history-root"), `root ${"routine ".repeat(2_000)}`);
for (let index = 0; index < 12; index += 1) {
  writeHistoryFile(
    `child-${index}.jsonl`,
    historyLine(`history-child-${index}`, "history-root"),
    `${historySecret}-${index} ${"duplicated tool output ".repeat(2_000)}`
  );
}
const previousCodexHome = process.env.CODEX_HOME;
process.env.CODEX_HOME = historyHome;
const historyTreatment = JSON.stringify(unified.insight({ history: true }).response.history);
if (historyTreatment.includes(historySecret) || !historyTreatment.includes("\"children\":12")) {
  throw new Error("History benchmark either exposed content or lost fan-out evidence");
}
if (previousCodexHome == null) delete process.env.CODEX_HOME;
else process.env.CODEX_HOME = previousCodexHome;
cases.push({
  name: "metadata-only-session-fanout-audit",
  category: "history-audit",
  prompt: "Measure root/subagent history fan-out without loading prompt or tool-output content.",
  query: "subagent history fan-out",
  baseline: historyFiles.join("\n"),
  treatment: historyTreatment,
  route: "unified:metadata-only-history-audit",
  invoked: true,
  expected: ["\"children\":12", "\"content_read\":false"],
  selection: "measured-transform",
});

const skillText = fs.readFileSync(
  path.join(__dirname, "..", "skills", "map-token-context", "SKILL.md"),
  "utf8"
);

process.stdout.write(JSON.stringify({
  ...original,
  activation_overhead: {
    tool_schema: JSON.stringify(schema),
    skill: "",
    optional_skill: skillText,
    server_instructions: schema.instructions,
  },
  cases,
}));

unified.closeSearchDatabase();
fs.rmSync(benchmarkState, { recursive: true, force: true });
