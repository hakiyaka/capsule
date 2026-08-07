"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-io-bench-"));
process.env.CAPSULE_STATE = state;

const hook = require("../scripts/hook.cjs");
const schema = require("../mcp/schema.cjs");
const core = require("../mcp/core.cjs");
const unified = require("../mcp/unified.cjs");

function percent(before, after) {
  return Number(((before - after) / before * 100).toFixed(2));
}

function replacementText(result) {
  return result?.continue === false && typeof result.reason === "string"
    ? result.reason
    : "";
}

function exposedChars(result, original) {
  const output = result?.hookSpecificOutput || {};
  const body = Object.hasOwn(output, "updatedMCPToolOutput")
    ? String(output.updatedMCPToolOutput)
    : replacementText(result) || String(original);
  return body.length + String(output.additionalContext || "").length;
}

function repeatedTextCase(rawChars) {
  const session = `io-text-${rawChars}`;
  const raw = `${"stable read-only evidence\n".repeat(Math.ceil(rawChars / 26))}`.slice(0, rawChars);
  const input = {
    tool_name: "workspace.read_file",
    tool_input: { path: path.join(os.tmpdir(), `evidence-${rawChars}.txt`) },
    tool_output: raw,
    cwd: process.cwd(),
    session_id: session,
  };
  hook.handle("userpromptsubmit", { cwd: process.cwd(), session_id: session, prompt: "Inspect the evidence." });
  const results = Array.from({ length: 5 }, () => hook.handle("posttooluse", input));
  const before = raw.length * results.length;
  const after = results.reduce((sum, result) => sum + exposedChars(result, raw), 0);
  return {
    raw_chars: raw.length,
    repetitions: results.length,
    a_unmediated_chars: before,
    b_capsule_chars: after,
    saving_percent: percent(before, after),
    exact_replays_compacted: results.slice(1).every((result) =>
      /\[Capsule replay\b/i.test(replacementText(result) || result?.hookSpecificOutput?.updatedMCPToolOutput || "")
    ),
  };
}

function threadCase() {
  const hidden = `TOOL-ARGUMENT-${"x".repeat(240_000)}`;
  const raw = JSON.stringify({
    schemaVersion: 1,
    thread: { id: "io-thread", title: "Payment decision log", status: { type: "idle" } },
    page: { hasMore: true, nextCursor: "older" },
    turns: [{
      id: "turn-1",
      items: [
        { type: "userMessage", content: [{ type: "text", text: "Preserve payment idempotency." }] },
        { type: "reasoning", summary: ["Check retry state transitions"] },
        {
          type: "mcpToolCall",
          server: "node_repl",
          tool: "js",
          arguments: { code: hidden },
          output: hidden,
        },
        { type: "agentMessage", phase: "final_answer", text: "Decision: retain the idempotency key." },
      ],
    }],
  });
  const result = hook.handle("posttooluse", {
    tool_name: "codex_app.read_thread",
    tool_input: { threadId: "io-thread", includeOutputs: false },
    tool_output: raw,
    cwd: process.cwd(),
    session_id: "io-thread-session",
  });
  const projected = replacementText(result) || String(result?.hookSpecificOutput?.updatedMCPToolOutput || raw);
  return {
    a_raw_chars: raw.length,
    b_projected_chars: projected.length,
    saving_percent: percent(raw.length, projected.length),
    preserves_user_decision: projected.includes("Preserve payment idempotency."),
    preserves_final_decision: projected.includes("Decision: retain the idempotency key."),
    removes_tool_argument: !projected.includes("TOOL-ARGUMENT-"),
  };
}

function crossTurnTextCase() {
  const session = "io-cross-turn-text";
  const raw = `${"cross-turn immutable evidence\n".repeat(10_000)}`.slice(0, 256 * 1024);
  const firstInput = {
    tool_name: "workspace.read_file",
    tool_input: { path: path.join(os.tmpdir(), "cross-turn-evidence.txt") },
    tool_output: raw,
    cwd: process.cwd(),
    session_id: session,
  };
  const first = hook.handle("posttooluse", firstInput);
  hook.handle("userpromptsubmit", {
    prompt: "Recheck the evidence in this same task.",
    cwd: process.cwd(),
    session_id: session,
  });
  const second = hook.handle("posttooluse", {
    ...firstInput,
    tool_name: "repository.get_file",
  });
  const before = raw.length * 2;
  const after = exposedChars(first, raw) + exposedChars(second, raw);
  return {
    turns: 2,
    read_only_tool_identities: 2,
    a_reloaded_chars: before,
    b_task_cache_chars: after,
    saving_percent: percent(before, after),
    second_result_is_reference: /\[Capsule replay\b/i.test(
      replacementText(second) || second?.hookSpecificOutput?.updatedMCPToolOutput || ""
    ),
  };
}

function progressiveExpandCase() {
  const text = Array.from(
    { length: 1_000 },
    (_, index) => `exact evidence line ${index + 1} ${"x".repeat(60)}`
  ).join("\n");
  const saved = core.saveCapsule({
    kind: "io-progressive-expand",
    source: "benchmark",
    text,
    maxChars: 1_200,
  });
  const legacy = core.expandAnchor({
    capsule_id: saved.response.capsule_id,
    start_line: 1,
    end_line: 1_000,
    max_chars: 6_000,
  }).response;
  const progressive = core.expandAnchor({
    capsule_id: saved.response.capsule_id,
    start_line: 1,
    end_line: 1_000,
    // Keep the treatment page bounded so this compares the old 6,000-character
    // page with the current progressive 2,400-character page. Leaving max_chars
    // unset asks Capsule for the full explicit range and measures expansion,
    // not savings.
    max_chars: 2_400,
  }).response;
  const before = JSON.stringify(legacy).length;
  const after = JSON.stringify(progressive).length;
  return {
    a_legacy_default_chars: before,
    b_progressive_default_chars: after,
    saving_percent: percent(before, after),
    first_line_preserved: /^\s*1 \| exact evidence line 1/m.test(progressive.excerpt),
    continuation_available: Number(progressive.next_start_line) > 1 &&
      progressive.next_end_line === 1_000,
  };
}

function forkCase() {
  const task = "Independently inspect C:\\work\\artifact.json for duplicate identifiers, invalid timestamps, " +
    "and missing required fields. Return only a compact JSON object with counts and affected identifiers. " +
    "Do not modify files or access the network. This message contains every input, constraint, and output rule.";
  const historyTurns = Array.from({ length: 20 }, (_, index) =>
    `turn-${index + 1}:${String(index).padStart(2, "0")}:${"historical context ".repeat(80)}`
  );
  const decision = hook.handle("pretooluse", {
    tool_name: "collaboration.spawn_agent",
    tool_input: { task_name: "io_fixture", message: task, fork_turns: "all" },
    cwd: process.cwd(),
    session_id: "io-fork-session",
  });
  const forkTurns = decision?.hookSpecificOutput?.updatedInput?.fork_turns;
  const retained = forkTurns === "none" ? [] : historyTurns.slice(-Number(forkTurns || historyTurns.length));
  const before = task.length + historyTurns.join("\n").length;
  const after = task.length + retained.join("\n").length;
  return {
    fixture_turns: historyTurns.length,
    selected_fork_turns: forkTurns || "all",
    a_full_history_chars: before,
    b_bounded_history_chars: after,
    simulated_saving_percent: percent(before, after),
    task_message_unchanged: decision?.hookSpecificOutput?.updatedInput?.message === task,
  };
}

function schemaCase() {
  const previousMeasuredContractChars = 1_004;
  const current = JSON.stringify({ tools: schema, instructions: schema.instructions }).length;
  return {
    a_v0_9_contract_chars: previousMeasuredContractChars,
    b_current_contract_chars: current,
    saving_percent: percent(previousMeasuredContractChars, current),
    action_count: Array.isArray(schema.actions)
      ? schema.actions.length
      : schema[0]?.inputSchema?.properties?.action?.enum?.length || 0,
  };
}

try {
  const text = [64 * 1024, 256 * 1024, 1024 * 1024].map(repeatedTextCase);
  const thread = threadCase();
  const crossTurn = crossTurnTextCase();
  const progressiveExpand = progressiveExpandCase();
  const fork = forkCase();
  const contract = schemaCase();
  const safetyPass = text.every((item) => item.exact_replays_compacted) &&
    thread.preserves_user_decision &&
    thread.preserves_final_decision &&
    thread.removes_tool_argument &&
    crossTurn.second_result_is_reference &&
    progressiveExpand.first_line_preserved &&
    progressiveExpand.continuation_available &&
    fork.selected_fork_turns === "none" &&
    fork.task_message_unchanged &&
    contract.action_count === schema.actions.length && schema.actions.includes("memory");
  const result = {
    method: {
      scope: "Deterministic characters exposed at hook/tool-schema boundaries.",
      treatment: "Current Capsule hooks and MCP contract.",
      exclusions: "No claim about provider billing, hidden platform prompts, image-token accounting, or answer-quality equivalence.",
      fork_note: "Fork savings use a synthetic 20-turn context fixture; they are not provider telemetry.",
    },
    summary: {
      scenarios: text.length + 5,
      safety_pass: safetyPass,
    },
    repeated_text: text,
    cross_turn_text_replay: crossTurn,
    progressive_expand: progressiveExpand,
    task_history_projection: thread,
    subagent_fork_fixture: fork,
    mcp_contract: contract,
  };
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  const writeAt = process.argv.indexOf("--write");
  if (writeAt >= 0) {
    const target = path.resolve(process.argv[writeAt + 1] || path.join(__dirname, "io-surface-results.json"));
    fs.writeFileSync(target, serialized, "utf8");
  }
  process.stdout.write(serialized);
  if (!safetyPass) process.exitCode = 1;
} finally {
  unified.closeSearchDatabase();
  fs.rmSync(state, { recursive: true, force: true });
}
