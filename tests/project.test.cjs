"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-project-state-"));
process.env.CAPSULE_STATE = state;
const core = require("../mcp/core.cjs");
const project = require("../mcp/project.cjs");
const schema = require("../mcp/schema.cjs");
const unified = require("../mcp/unified.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-project-work-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "main.js"),
    [
      'import { computeTotal } from "./math.js";',
      "export function handleInvoice(items) {",
      "  return computeTotal(items);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "src", "math.js"),
    [
      "export function computeTotal(items) {",
      "  return items.reduce((sum, item) => sum + item.price, 0);",
      "}",
      ...Array.from({ length: 240 }, (_, index) => `// stable implementation note ${index}`),
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "tests", "invoice.test.js"),
    [
      'import { handleInvoice } from "../src/main.js";',
      'test("invoice total", () => expect(handleInvoice([{ price: 4 }])).toBe(4));',
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "project-fixture", scripts: { test: "node --test" } }, null, 2),
    "utf8",
  );
  return root;
}

test.after(() => {
  fs.rmSync(state, { recursive: true, force: true });
});

test("Project Compiler performs cold, warm, and incremental semantic scans", () => {
  const root = fixture();
  try {
    const cold = project.scanProject({ root });
    assert.equal(cold.response.cache_mode, "cold");
    assert.equal(cold.response.stats.files, 4);
    assert.equal(cold.response.changed, 4);
    assert.equal(cold.response.reused, 0);
    assert.ok(cold.response.stats.symbols >= 2);
    assert.ok(cold.response.stats.resolved_edges >= 2);
    assert.match(cold.response.exact, /^cap_[a-f0-9]{16}$/);

    const warm = project.scanProject({ root });
    assert.equal(warm.response.cache_mode, "warm");
    assert.equal(warm.response.changed, 0);
    assert.equal(warm.response.reused, 4);
    assert.equal(warm.response.metadata_reused, 4);
    assert.equal(warm.response.hashed, 0);
    const verified = project.scanProject({ root, fast_cache: false });
    assert.equal(verified.response.cache_validation, "sha256");
    assert.equal(verified.response.metadata_reused, 0);
    assert.equal(verified.response.hashed, 4);

    fs.appendFileSync(
      path.join(root, "src", "math.js"),
      "\nexport function roundTotal(value) { return Math.round(value); }\n",
      "utf8",
    );
    const incremental = project.scanProject({ root });
    assert.equal(incremental.response.cache_mode, "incremental");
    assert.equal(incremental.response.changed, 1);
    assert.equal(incremental.response.reused, 3);
    assert.equal(incremental.response.metadata_reused, 3);
    assert.equal(incremental.response.hashed, 1);
    assert.ok(project.loadIndex(fs.realpathSync(root).replace(/\\/g, "/"))
      .files["src/math.js"].symbols.some((symbol) => symbol.name === "roundTotal"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refactor proof packet carries symbol spans and hashes without code bodies", () => {
  const root = fixture();
  try {
    const cold = project.dispatch({
      operation: "refactor",
      root,
      target: "computeTotal",
      depth: 2,
      max_files: 8,
      max_chars: 4_000,
    });
    assert.equal(cold.route, "project-refactor-proof");
    assert.ok(cold.response.selected_files.some((file) => file.path === "src/math.js"));
    assert.ok(cold.response.selected_files.some((file) => file.path === "src/main.js"));
    assert.ok(cold.response.tests.some((file) => file.path === "tests/invoice.test.js"));
    assert.ok(cold.response.selected_files.some((file) => file.symbols.some((symbol) => symbol.name === "computeTotal")));
    assert.match(cold.responseText, /proof=hash\+span\+dependency-cone/);
    assert.match(cold.responseText, /hash=[a-f0-9]{12}/);
    assert.doesNotMatch(cold.responseText, /stable implementation note 200/);

    const warm = project.dispatch({
      operation: "refactor",
      root,
      target: "computeTotal",
      depth: 2,
      max_files: 8,
      max_chars: 4_000,
    });
    assert.equal(warm.response.cache_mode, "warm");
    assert.equal(warm.response.metadata_reused, 4);
    assert.equal(warm.response.hashed, 0);
    assert.match(warm.responseText, /metadata_reused=4; hashed=0/);
    assert.equal(warm.response.profit_gate.baseline_kind, "symbol-hash-impact-manifest");

    const bounded = project.dispatch({
      operation: "refactor",
      root,
      target: "computeTotal",
      max_chars: 2_000,
      max_tokens: 64,
    });
    assert.ok(bounded.response.profit_gate.emitted_tokens <= 64);
    assert.ok(bounded.responseText.length <= 2_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("project root selects the canonical codebase without cwd fallback", async () => {
  const root = fixture();
  const missing = path.join(os.tmpdir(), `capsule-project-missing-${Date.now()}`);
  try {
    const canonical = fs.realpathSync(root).replace(/\\/g, "/");
    const byRoot = project.dispatch({ operation: "scan", root });
    assert.equal(byRoot.response.root, canonical);

    assert.equal(project.dispatch({
      operation: "query", root, query: "computeTotal", max_files: 4,
    }).response.root, canonical);
    assert.equal(project.dispatch({
      operation: "impact", root, target: "computeTotal", max_files: 4,
    }).response.root, canonical);
    assert.equal(project.dispatch({ operation: "status", root }).response.root, canonical);
    const live = await unified.dispatch({
      action: "project",
      payload: { operation: "status", root },
    });
    assert.equal(live.response.root, canonical);

    assert.throws(
      () => project.dispatch({ operation: "scan", root: missing }),
      /project root does not exist/,
    );
    assert.throws(
      () => project.dispatch({ operation: "scan", root: "" }),
      /payload\.root must be a non-empty path/,
    );
    assert.throws(
      () => project.dispatch({ operation: "gc", root }),
      /project gc is global/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Project Compiler emits a task-conditioned proof packet with an impact cone", () => {
  const root = fixture();
  try {
    const operation = project.queryProject({
      root,
      query: "Where is invoice total computed and which test exercises it?",
      depth: 2,
      max_files: 8,
      max_chars: 8_000,
    });
    assert.equal(operation.route, "project-proof-packet");
    assert.equal(operation.response.profit_gate.profitable, true);
    assert.ok(operation.response.profit_gate.avoided_tokens > 0);
    const selected = operation.response.selected_files.map((file) => file.path);
    assert.ok(selected.includes("src/main.js"));
    assert.ok(selected.includes("src/math.js"));
    assert.ok(selected.includes("tests/invoice.test.js"));
    assert.match(operation.response.exact, /^cap_[a-f0-9]{16}$/);
    const exact = JSON.parse(core.loadCapsule(operation.response.exact).text);
    assert.equal(exact.query, "Where is invoice total computed and which test exercises it?");
    assert.ok(exact.selected_files.some((file) => /stable implementation note 200/.test(file.text)));
    assert.match(operation.responseText, /computeTotal/);
    assert.doesNotMatch(operation.responseText, /stable implementation note 200/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Project Compiler reverse impact includes importers and keeps dynamic uncertainty explicit", () => {
  const root = fixture();
  try {
    const operation = project.dispatch({
      operation: "impact",
      root,
      target: "computeTotal",
      direction: "reverse",
      depth: 2,
      max_files: 8,
    });
    const selected = operation.response.selected_files.map((file) => file.path);
    assert.ok(selected.includes("src/math.js"));
    assert.ok(selected.includes("src/main.js"));
    assert.ok(selected.includes("tests/invoice.test.js"));
    assert.match(operation.response.impact.negative_certificate, /dynamic|resolved dependency/i);
    assert.ok(operation.response.uncertainty.some((item) => /dynamic imports/i.test(item)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Project Compiler profit gate never makes a tiny selected context larger", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-project-tiny-"));
  try {
    fs.writeFileSync(path.join(root, "main.js"), "export const answer = 42;\n", "utf8");
    const operation = project.queryProject({
      root,
      query: "answer",
      max_files: 1,
      max_chars: 800,
    });
    assert.equal(operation.route, "project-profit-passthrough");
    assert.equal(operation.response.profit_gate.profitable, false);
    assert.ok(
      operation.response.profit_gate.emitted_tokens <=
      operation.response.profit_gate.baseline_tokens,
    );
    assert.match(operation.responseText, /answer = 42/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Project query selection limits never truncate the underlying repository scan", () => {
  const root = fixture();
  try {
    fs.writeFileSync(
      path.join(root, "src", "dispatcher.cjs"),
      [
        '"use strict";',
        "function dispatchProjectAction(action) { return action === \"project\"; }",
        "module.exports = { dispatchProjectAction };",
        "",
      ].join("\n"),
      "utf8",
    );
    const operation = project.queryProject({
      root,
      query: "dispatch project action",
      max_files: 1,
      max_chars: 2_000,
    });
    assert.equal(operation.response.index.files, 5);
    assert.equal(operation.response.selected_files.length, 1);
    assert.equal(operation.response.selected_files[0].path, "src/dispatcher.cjs");
    assert.equal(operation.response.selected_files[0].language, "javascript");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dependency PageRank selects the architectural hub within a tight context budget", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-project-rank-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "src", "entry.js"),
      [
        'import { lowValue } from "./a-low.js";',
        'import { sharedCore } from "./hub.js";',
        "export function launchRequest() { return sharedCore(lowValue); }",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(path.join(root, "src", "a-low.js"), "export const lowValue = 1;\n", "utf8");
    fs.writeFileSync(path.join(root, "src", "hub.js"), "export function sharedCore(v) { return v; }\n", "utf8");
    fs.writeFileSync(
      path.join(root, "src", "consumer-one.js"),
      'import { sharedCore } from "./hub.js";\nexport const one = sharedCore(1);\n',
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, "src", "consumer-two.js"),
      'import { sharedCore } from "./hub.js";\nexport const two = sharedCore(2);\n',
      "utf8",
    );

    const operation = project.queryProject({
      root,
      query: "launchRequest",
      direction: "both",
      depth: 1,
      seed_limit: 1,
      max_files: 2,
      max_chars: 2_000,
    });
    const indexed = project.loadIndex(fs.realpathSync(root).replace(/\\/g, "/"));
    assert.equal(indexed.edges["src/entry.js"][0], "src/a-low.js");
    const selected = operation.response.selected_files.map((file) => file.path);
    assert.deepEqual(selected, ["src/entry.js", "src/hub.js"]);
    assert.equal(operation.response.impact.rank_strategy, "lexical-idf+dependency-pagerank");
    assert.ok(operation.response.impact.candidates_ranked > operation.response.selected_files.length);
    assert.ok(
      operation.response.selected_files[1].centrality >
      project.graphRanks(indexed, "both").get("src/a-low.js"),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("symbol retrieval returns a complete bounded function body instead of a three-line window", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-project-symbol-"));
  try {
    fs.writeFileSync(
      path.join(root, "orders.js"),
      [
        "export function normalizeOrder(order) {",
        "  const id = String(order.id).trim();",
        "  const items = order.items.filter(Boolean);",
        "  const subtotal = items.reduce((sum, item) => sum + item.price, 0);",
        "  const tax = subtotal * 0.2;",
        "  return { id, items, subtotal, tax };",
        "}",
        "",
        "export const unrelated = true;",
        "",
      ].join("\n"),
      "utf8",
    );
    const operation = project.queryProject({
      root,
      query: "normalizeOrder",
      max_files: 1,
      max_chars: 4_000,
      symbol_max_chars: 2_000,
    });
    const indexed = project.loadIndex(fs.realpathSync(root).replace(/\\/g, "/"));
    const symbol = indexed.files["orders.js"].symbols.find((item) => item.name === "normalizeOrder");
    assert.equal(symbol.line, 1);
    assert.equal(symbol.end_line, 7);
    assert.match(operation.responseText, /const tax = subtotal \* 0\.2/);
    const evidence = operation.response.selected_files[0].evidence[0];
    assert.equal(evidence.kind, "symbol-body");
    assert.equal(evidence.complete, true);
    assert.equal(evidence.start_line, 1);
    assert.equal(evidence.end_line, 7);
    assert.doesNotMatch(evidence.excerpt, /unrelated/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("project packet packing preserves ranked file diversity and a complete footer under pressure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-project-pack-"));
  try {
    for (const [name, suffix] of [["a-first", "Alpha"], ["b-second", "Beta"], ["c-third", "Gamma"]]) {
      fs.writeFileSync(
        path.join(root, `${name}.js`),
        [
          `export function sharedBudget${suffix}(input) {`,
          ...Array.from({ length: 36 }, (_, index) => `  const value${index} = input + ${index};`),
          "  return input;",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
    }
    const operation = project.queryProject({
      root,
      query: "sharedBudget",
      depth: 0,
      seed_limit: 3,
      max_files: 3,
      max_chars: 1_800,
      max_tokens: 450,
      symbol_max_chars: 5_000,
    });
    assert.ok(operation.responseText.length <= 1_800);
    assert.ok(core.estimateTokens(operation.responseText) <= 450);
    assert.match(operation.responseText, /@a-first\.js/);
    assert.match(operation.responseText, /@b-second\.js/);
    assert.match(operation.responseText, /@c-third\.js/);
    assert.match(operation.responseText, /packing: visible_files=3\/3/);
    assert.match(operation.responseText, /exclusion:/);
    assert.equal(operation.response.packing.strategy, "ranked-coverage+utility-per-token");
    assert.equal(operation.response.packing.visible_files, 3);
    assert.ok(operation.response.packing.truncated_evidence > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Project Compiler redacts visible secrets while retaining exact local proof", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-project-secret-"));
  try {
    fs.writeFileSync(
      path.join(root, "main.js"),
      'export const api_token = "project-secret-value";\n',
      "utf8",
    );
    const operation = project.queryProject({
      root,
      query: "api token",
      max_files: 1,
      max_chars: 800,
    });
    assert.match(operation.responseText, /\[REDACTED\]/);
    assert.doesNotMatch(operation.responseText, /project-secret-value/);
    assert.match(core.loadCapsule(operation.response.exact).text, /project-secret-value/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Project cache evicts least-recent projects when its quota is exceeded", () => {
  const roots = Array.from({ length: 3 }, () =>
    fs.mkdtempSync(path.join(os.tmpdir(), "capsule-project-lru-")));
  try {
    for (const [index, root] of roots.entries()) {
      fs.writeFileSync(path.join(root, "main.js"), `export const value${index} = ${index};\n`, "utf8");
      project.scanProject({
        root,
        cache_max_projects: 2,
        cache_max_bytes: 16 * 1024 * 1024,
        cache_ttl_days: 365,
      });
    }
    const entries = fs.readdirSync(path.join(state, "projects"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory());
    assert.equal(entries.length, 2);
    const current = project.loadIndex(fs.realpathSync(roots[2]).replace(/\\/g, "/"));
    assert.ok(current);
  } finally {
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Project gc and targeted project purge report and remove bounded cache state", async () => {
  const root = fixture();
  try {
    project.scanProject({ root });
    const gc = project.dispatch({
      operation: "gc",
      cache_max_projects: 1,
      capsule_max_entries: 20,
      capsule_min_recent: 2,
    });
    assert.equal(gc.route, "project-cache-gc");
    assert.ok(gc.response.projects.projects_after <= 1);
    assert.ok(gc.response.capsules.entries_after <= 20);
    const purged = await unified.dispatch({
      action: "purge",
      payload: { scope: "projects", confirm: true },
    });
    assert.equal(purged.response.scope, "projects");
    assert.equal(fs.existsSync(path.join(state, "projects")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Exact capsule gc evicts old source references but preserves the newest proof", () => {
  const ids = [];
  for (let index = 0; index < 6; index += 1) {
    ids.push(core.saveCapsule({
      kind: "project-gc-test",
      source: `gc-source-${index}`,
      text: `proof ${index} ${"x".repeat(300)}`,
      maxChars: 800,
    }).response.capsule_id);
  }
  const gc = core.maintainCapsuleCache({
    max_entries: 2,
    max_bytes: 16 * 1024 * 1024,
    ttl_days: 365,
    min_recent: 1,
    include_ids: true,
  });
  assert.ok(gc.entries_after <= 2);
  assert.ok(gc.removed > 0);
  assert.doesNotThrow(() => core.loadCapsule(ids.at(-1)));
  assert.throws(() => core.loadCapsule(ids[0]), /not found/i);
});

test("Capsule schema exposes the project action", () => {
  assert.ok(schema.actions.includes("project"));
  assert.match(schema[0].description, /project/);
});
