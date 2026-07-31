"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-cognition-state-"));
process.env.CAPSULE_STATE = state;
const cognition = require("../mcp/cognition.cjs");
const hook = require("../scripts/hook.cjs");
const unified = require("../mcp/unified.cjs");

test.after(() => {
  unified.closeSearchDatabase();
  fs.rmSync(state, { recursive: true, force: true });
});

test("compile emits no context for trivial prompts and resolves bounded arithmetic with a certificate", () => {
  const trivial = cognition.compile({ prompt: "merhaba" });
  assert.equal(trivial.response.mode, "bypass");
  assert.equal(trivial.response.context, "");

  const resolved = cognition.compile({ prompt: "Hesapla: ((144 / 12) + 7) * 3" });
  assert.equal(resolved.response.mode, "resolved");
  assert.equal(resolved.response.answer, "57");
  assert.equal(resolved.response.certificate.solver, "arithmetic-v1");
  assert.ok(resolved.response.context.length < 180);
});

test("pre-spend token escrow budgets the first generation without constraining explicit detail", () => {
  const trivial = cognition.planEscrow({ prompt: "merhaba" }).response;
  assert.equal(trivial.active, false);
  assert.equal(trivial.context, "");

  const action = cognition.planEscrow({
    prompt: "Implement the fix, run tests, and verify the package.",
    pressure_mode: "normal",
  }).response;
  assert.equal(action.active, true);
  assert.equal(action.class, "action");
  assert.equal(action.word_budget, 220);
  assert.ok(action.predicted_net_tokens_avoided > 300);
  assert.match(action.context, /one branch/i);
  assert.match(action.context, /verify>=25%/i);

  const emergency = cognition.planEscrow({
    prompt: "Compare every implementation option and choose the safest architecture.",
    pressure_mode: "emergency",
  }).response;
  assert.equal(emergency.active, true);
  assert.equal(emergency.class, "branching");
  assert.ok(emergency.word_budget < action.word_budget);
  assert.equal(emergency.tool_round_budget, 2);

  const detailed = cognition.planEscrow({
    prompt: "Write an exhaustive step by step implementation guide with full detail.",
    pressure_mode: "emergency",
  }).response;
  assert.equal(detailed.explicit_detail, true);
  assert.ok(detailed.word_budget >= 700);
  assert.match(detailed.context, /explicit user detail and correctness override/i);
});

test("compile auto-solves an embedded cognitive bytecode packet before the model reasons", () => {
  const packet = {
    operation: "cover",
    requirements: ["read", "test"],
    candidates: [
      { id: "both", covers: ["read", "test"], cost: 4 },
      { id: "read", covers: ["read"], cost: 1 },
      { id: "test", covers: ["test"], cost: 1 },
    ],
  };
  const compiled = cognition.compile({
    prompt: `Find the minimum set. Data=${JSON.stringify(packet)}`,
  }).response;
  assert.equal(compiled.mode, "resolved");
  assert.equal(compiled.recommended_operation, "cover");
  assert.deepEqual(compiled.answer.selected, ["read", "test"]);
  assert.match(compiled.context, /certificate/i);
  assert.match(compiled.context, /do not recompute/i);
  assert.ok(compiled.context.length < 900);
});

test("minimum cover replaces combinatorial branch exploration with an exact proof", () => {
  const result = cognition.solve({
    operation: "cover",
    requirements: ["read", "test", "verify"],
    candidates: [
      { id: "a", covers: ["read", "test"], cost: 3 },
      { id: "b", covers: ["verify"], cost: 1 },
      { id: "c", covers: ["read", "test", "verify"], cost: 10 },
      { id: "d", covers: ["read"], cost: 1 },
      { id: "e", covers: ["test"], cost: 1 },
    ],
  }).response;
  assert.deepEqual(result.selected, ["b", "d", "e"]);
  assert.equal(result.total_cost, 3);
  assert.equal(result.certificate.complete, true);
  assert.deepEqual(result.certificate.missing, []);
  assert.ok(result.certificate.search_space >= 31);
});

test("DAG solver returns parallel batches, a weighted critical path, and a cycle certificate", () => {
  const planned = cognition.solve({
    operation: "dag",
    tasks: [
      { id: "inspect", cost: 2 },
      { id: "edit", after: ["inspect"], cost: 3 },
      { id: "test", after: ["edit"], cost: 5 },
      { id: "docs", after: ["edit"], cost: 1 },
      { id: "pack", after: ["test", "docs"], cost: 2 },
    ],
  }).response;
  assert.deepEqual(planned.batches, [["inspect"], ["edit"], ["docs", "test"], ["pack"]]);
  assert.deepEqual(planned.critical_path, ["inspect", "edit", "test", "pack"]);
  assert.equal(planned.certificate.acyclic, true);

  const cyclic = cognition.solve({
    operation: "dag",
    tasks: [
      { id: "a", after: ["b"] },
      { id: "b", after: ["a"] },
    ],
  }).response;
  assert.equal(cyclic.certificate.acyclic, false);
  assert.deepEqual(cyclic.certificate.cycle_nodes, ["a", "b"]);
});

test("decision and hypothesis solvers return ranked, checksum-certified conclusions", () => {
  const decision = cognition.solve({
    operation: "decide",
    criteria: [
      { id: "quality", weight: 3, direction: "max" },
      { id: "cost", weight: 1, direction: "min" },
    ],
    options: [
      { id: "x", scores: { quality: 9, cost: 8 } },
      { id: "y", scores: { quality: 7, cost: 2 } },
      { id: "z", scores: { quality: 4, cost: 1 } },
    ],
  }).response;
  assert.equal(decision.winner, "x");
  assert.equal(decision.certificate.complete, true);
  assert.match(decision.certificate.input_sha256, /^[a-f0-9]{64}$/);

  const hypotheses = cognition.solve({
    operation: "hypotheses",
    hypotheses: [
      { id: "cache", prior: 0.5 },
      { id: "database", prior: 0.3 },
      { id: "network", prior: 0.2 },
    ],
    checks: [
      { id: "clear-cache", cost: 1, positive: { cache: 0.95, database: 0.1, network: 0.1 } },
      { id: "full-trace", cost: 8, positive: { cache: 0.6, database: 0.7, network: 0.8 } },
    ],
  }).response;
  assert.equal(hypotheses.next_check, "clear-cache");
  assert.ok(hypotheses.ranking[0].information_gain_per_cost > hypotheses.ranking[1].information_gain_per_cost);
  assert.equal(hypotheses.certificate.normalized_priors, true);
});

test("assignment, knapsack, and shortest-path solvers externalize common finite search", () => {
  const assigned = cognition.solve({
    operation: "assign",
    agents: ["ada", "linus", "grace"],
    tasks: ["api", "docs", "tests"],
    costs: {
      ada: { api: 1, docs: 7, tests: 4 },
      linus: { api: 5, docs: 2, tests: 6 },
      grace: { api: 4, docs: 6, tests: 1 },
    },
  }).response;
  assert.deepEqual(assigned.assignments, [
    { task: "api", agent: "ada", cost: 1 },
    { task: "docs", agent: "linus", cost: 2 },
    { task: "tests", agent: "grace", cost: 1 },
  ]);
  assert.equal(assigned.total_cost, 4);
  assert.equal(assigned.certificate.complete, true);

  const packed = cognition.solve({
    operation: "knapsack",
    budget: 9,
    items: [
      { id: "a", cost: 5, value: 10 },
      { id: "b", cost: 4, value: 9 },
      { id: "c", cost: 3, value: 6 },
      { id: "d", cost: 2, value: 4 },
    ],
  }).response;
  assert.deepEqual(packed.selected, ["a", "b"]);
  assert.equal(packed.total_cost, 9);
  assert.equal(packed.total_value, 19);

  const routed = cognition.solve({
    operation: "path",
    source: "a",
    target: "e",
    edges: [
      { from: "a", to: "b", cost: 4 },
      { from: "a", to: "c", cost: 1 },
      { from: "c", to: "b", cost: 1 },
      { from: "b", to: "e", cost: 2 },
      { from: "c", to: "e", cost: 8 },
    ],
  }).response;
  assert.deepEqual(routed.path, ["a", "c", "b", "e"]);
  assert.equal(routed.total_cost, 4);
  assert.equal(routed.certificate.reachable, true);
});

test("compile recognizes and solves new cognitive bytecode packets", () => {
  const packet = {
    operation: "knapsack",
    budget: 5,
    items: [
      { id: "small", cost: 2, value: 4 },
      { id: "large", cost: 5, value: 9 },
    ],
  };
  const compiled = cognition.compile({
    prompt: `Choose the maximum-value subset within budget. Data=${JSON.stringify(packet)}`,
  }).response;
  assert.equal(compiled.mode, "resolved");
  assert.equal(compiled.recommended_operation, "knapsack");
  assert.deepEqual(compiled.answer.selected, ["large"]);
  assert.equal(compiled.answer.total_value, 9);
});

test("reasoning governor reads provider telemetry and emits each threshold once per turn", () => {
  const previousSessionsRoot = process.env.CAPSULE_SESSIONS_ROOT;
  const sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-sessions-"));
  const session = "019fa018-5fee-7a61-a960-5b03036b025f";
  const sessionFile = path.join(sessionsRoot, `rollout-${session}.jsonl`);
  const event = (reasoning) => JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: 1000,
          output_tokens: 100,
          reasoning_output_tokens: reasoning,
          total_tokens: 1100 + reasoning,
        },
        last_token_usage: {
          input_tokens: 10,
          output_tokens: 2,
          reasoning_output_tokens: 1,
          total_tokens: 13,
        },
      },
    },
  });
  process.env.CAPSULE_SESSIONS_ROOT = sessionsRoot;
  try {
    fs.writeFileSync(sessionFile, `${event(100)}\n`, "utf8");
    cognition.startGovernor({ session, session_file: sessionFile, warning: 500, hard: 1500 });
    fs.appendFileSync(sessionFile, `${event(700)}\n`, "utf8");
    const warning = cognition.checkGovernor({
      session,
      session_file: sessionFile,
      warning: 500,
      hard: 1500,
    }).response;
    assert.equal(warning.level, "warning");
    assert.equal(warning.reasoning_delta, 600);
    assert.equal(warning.emit, true);
    assert.match(warning.context, /\br=600\b/i);

    const duplicate = cognition.checkGovernor({
      session,
      session_file: sessionFile,
      warning: 500,
      hard: 1500,
    }).response;
    assert.equal(duplicate.level, "warning");
    assert.equal(duplicate.emit, false);

    fs.appendFileSync(sessionFile, `${event(1800)}\n`, "utf8");
    const brake = cognition.checkGovernor({
      session,
      session_file: sessionFile,
      warning: 500,
      hard: 1500,
    }).response;
    assert.equal(brake.level, "brake");
    assert.equal(brake.reasoning_delta, 1700);
    assert.equal(brake.emit, true);
    assert.match(brake.context, /finish minimum verified path/i);

    const status = cognition.governor({ mode: "status", session, session_file: sessionFile }).response;
    assert.equal(status.available, true);
    assert.equal(status.total.reasoning_output_tokens, 1800);
    assert.equal(status.reasoning_delta, 1700);
    assert.equal(status.privacy, "token counters only; prompts and responses are not read");

    const creditSession = "019fa018-5fee-7a61-a960-5b03036b0255";
    const creditFile = path.join(sessionsRoot, `rollout-${creditSession}.jsonl`);
    const creditEvent = ({ input, cached, output, reasoning }) => JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
            reasoning_output_tokens: reasoning,
            total_tokens: input + output + reasoning,
          },
          last_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
            reasoning_output_tokens: reasoning,
            total_tokens: input + output + reasoning,
          },
        },
      },
    });
    fs.writeFileSync(
      creditFile,
      `${creditEvent({ input: 1000, cached: 900, output: 50, reasoning: 10 })}\n`,
      "utf8"
    );
    cognition.startGovernor({
      session: creditSession,
      session_file: creditFile,
      warning: 500,
      hard: 1500,
    });
    fs.appendFileSync(
      creditFile,
      `${creditEvent({ input: 1500, cached: 900, output: 700, reasoning: 20 })}\n`,
      "utf8"
    );
    const creditWarning = cognition.checkGovernor({
      session: creditSession,
      session_file: creditFile,
      warning: 500,
      hard: 1500,
    }).response;
    assert.equal(creditWarning.reasoning_delta, 10);
    assert.equal(creditWarning.level, "warning");
    assert.ok(creditWarning.credit_weighted_delta >= 4_096);
    assert.equal(creditWarning.credit_output_multiplier, 6);
    assert.equal(creditWarning.credit_cached_multiplier, 0.1);
    assert.match(creditWarning.context, /\bcw=\d+/i);

    fs.appendFileSync(
      creditFile,
      `${creditEvent({ input: 2000, cached: 900, output: 2200, reasoning: 30 })}\n`,
      "utf8"
    );
    const creditBrake = cognition.checkGovernor({
      session: creditSession,
      session_file: creditFile,
      warning: 500,
      hard: 1500,
    }).response;
    assert.equal(creditBrake.level, "brake");
    assert.ok(creditBrake.credit_weighted_delta >= 12_288);

    const hookSession = "019fa018-5fee-7a61-a960-5b03036b0260";
    const hookFile = path.join(sessionsRoot, `rollout-${hookSession}.jsonl`);
    fs.writeFileSync(hookFile, `${event(50)}\n`, "utf8");
    cognition.startGovernor({ session: hookSession, session_file: hookFile, warning: 500, hard: 1500 });
    fs.appendFileSync(hookFile, `${event(650)}\n`, "utf8");
    const governedHook = hook.handle("pretooluse", {
      session_id: hookSession,
      session_file: hookFile,
      tool_name: "view_image",
      tool_input: { path: "fixture.png" },
    });
    assert.equal(governedHook.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.match(governedHook.hookSpecificOutput.additionalContext, /Capsule governor/i);

    const pressuredSession = "019fa018-5fee-7a61-a960-5b03036b0270";
    const pressuredFile = path.join(sessionsRoot, `rollout-${pressuredSession}.jsonl`);
    const pressureEvent = (input, reasoning) => JSON.stringify({
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          model_context_window: 100_000,
          total_token_usage: {
            input_tokens: input,
            output_tokens: 100,
            reasoning_output_tokens: reasoning,
            total_tokens: input + 100 + reasoning,
          },
          last_token_usage: {
            input_tokens: input,
            output_tokens: 2,
            reasoning_output_tokens: 1,
            total_tokens: input + 3,
          },
        },
      },
    });
    fs.writeFileSync(pressuredFile, `${pressureEvent(20_000, 100)}\n`, "utf8");
    cognition.startGovernor({ session: pressuredSession, session_file: pressuredFile });
    fs.appendFileSync(pressuredFile, `${pressureEvent(85_000, 400)}\n`, "utf8");
    const adaptive = hook.handle("pretooluse", {
      session_id: pressuredSession,
      session_file: pressuredFile,
      tool_name: "view_image",
      tool_input: { path: "critical-context.png" },
    });
    assert.match(adaptive.hookSpecificOutput.additionalContext, /Capsule governor/i);
    const adaptiveStatus = cognition.governor({
      mode: "status",
      session: pressuredSession,
      session_file: pressuredFile,
    }).response;
    assert.equal(adaptiveStatus.warning, 256);
    assert.equal(adaptiveStatus.hard, 640);
  } finally {
    if (previousSessionsRoot == null) delete process.env.CAPSULE_SESSIONS_ROOT;
    else process.env.CAPSULE_SESSIONS_ROOT = previousSessionsRoot;
    fs.rmSync(sessionsRoot, { recursive: true, force: true });
  }
});

test("decision kernels recall exact/similar work without persisting the raw prompt", () => {
  const prompt = "Re-run the compact regression suite and verify the package checksum";
  const stored = cognition.remember({
    prompt,
    project: "project:test",
    solution: "Run npm test; verify 68 passing; compute SHA-256. Capsule controls reasoning-token growth.",
  }).response;
  assert.match(stored.kernel_id, /^ck_/);

  const recalled = cognition.recall({
    prompt: "Re-run compact regression suite and verify package checksum",
    project: "project:test",
  }).response;
  assert.equal(recalled.hit, true);
  assert.ok(recalled.score >= 0.8);
  assert.match(recalled.kernel, /npm test/);
  assert.match(recalled.kernel, /Capsule controls reasoning-token growth/);

  const persisted = fs.readdirSync(path.join(state, "cognition", "kernels"))
    .map((name) => fs.readFileSync(path.join(state, "cognition", "kernels", name), "utf8"))
    .join("\n");
  assert.doesNotMatch(persisted, new RegExp(prompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("UserPromptSubmit injects token escrow and cognition only when they predict a positive win", () => {
  assert.deepEqual(hook.handle("userpromptsubmit", {
    cwd: process.cwd(),
    session_id: "cognition-trivial",
    prompt: "merhaba",
  }), {});

  const branchy = hook.handle("userpromptsubmit", {
    cwd: process.cwd(),
    session_id: "cognition-branchy",
    prompt: "Compare five implementation options against security, latency, cost, and portability, then choose one.",
  });
  assert.equal(branchy.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(branchy.hookSpecificOutput.additionalContext, /Capsule budget v2/i);
  assert.match(branchy.hookSpecificOutput.additionalContext, /cognition/i);
  assert.match(branchy.hookSpecificOutput.additionalContext, /decision/i);
  const escrowStatus = cognition.escrowStatus().response;
  assert.ok(escrowStatus.active_turns >= 1);
  assert.ok(escrowStatus.predicted_net_tokens_avoided > 0);

  const arithmetic = hook.handle("userpromptsubmit", {
    cwd: process.cwd(),
    session_id: "cognition-arithmetic",
    prompt: "Hesapla: (250 * 4) - 37",
  });
  assert.match(arithmetic.hookSpecificOutput.additionalContext, /963/);
  assert.match(arithmetic.hookSpecificOutput.additionalContext, /certificate/i);
});

test("Stop distills a prompt fingerprint and final into a cross-session decision replay", () => {
  const prompt = "Compare alpha beta and gamma for latency cost security and choose the winner";
  hook.handle("userpromptsubmit", {
    cwd: process.cwd(),
    session_id: "cognition-kernel-source",
    prompt,
  });
  hook.handle("stop", {
    cwd: process.cwd(),
    session_id: "cognition-kernel-source",
    last_assistant_message: "Winner beta. Verified with npm test: 75 passing.",
  });
  const replay = hook.handle("userpromptsubmit", {
    cwd: process.cwd(),
    session_id: "cognition-kernel-target",
    prompt,
  });
  assert.match(replay.hookSpecificOutput.additionalContext, /cognition replay/i);
  assert.match(replay.hookSpecificOutput.additionalContext, /Winner beta/);
  assert.match(replay.hookSpecificOutput.additionalContext, /state and evidence are unchanged/i);
});

test("cognition is available through the single capsule dispatch surface", async () => {
  const result = await unified.dispatch({
    action: "cognition",
    payload: {
      operation: "cover",
      requirements: ["a"],
      candidates: [{ id: "only", covers: ["a"], cost: 1 }],
    },
  });
  assert.deepEqual(result.response.selected, ["only"]);
});
