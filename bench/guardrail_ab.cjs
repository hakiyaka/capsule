"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const pluginRoot = path.resolve(__dirname, "..");
const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-guardrail-ab-"));
process.env.CAPSULE_STATE = state;
process.env.CAPSULE_RECALL_LIMIT = "0";
process.env.CAPSULE_REASONING_GOVERNOR = "0";

function argument(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

function versionTuple(value) {
  return String(value).split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(left, right) {
  const a = versionTuple(left);
  const b = versionTuple(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) - (b[index] || 0);
  }
  return String(left).localeCompare(String(right));
}

function baselineRoot() {
  const explicit = argument("--baseline");
  if (explicit) return path.resolve(explicit);
  const currentVersion = require("../package.json").version;
  const root = path.join(os.homedir(), ".codex", "plugins", "cache", "personal", "capsule");
  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) =>
      compareVersions(name, currentVersion) < 0 &&
      fs.existsSync(path.join(root, name, "scripts", "skill-router.cjs"))
    )
    .sort(compareVersions);
  if (!candidates.length) throw new Error("No older installed Capsule baseline found; pass --baseline.");
  return path.join(root, candidates.at(-1));
}

function route(root, query) {
  const result = spawnSync(process.execPath, [
    path.join(root, "scripts", "skill-router.cjs"),
    "route",
    query,
  ], {
    cwd: pluginRoot,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(result.stderr || `router exited ${result.status}`);
  return JSON.parse(result.stdout);
}

function selectedBodyChars(result) {
  const file = result.matches?.[0]?.skill_file;
  if (!file || !fs.existsSync(file)) return 0;
  return fs.readFileSync(file, "utf8").length;
}

function visible(result, raw) {
  const hook = result?.hookSpecificOutput || {};
  const output = hook.updatedMCPToolOutput == null ? raw : String(hook.updatedMCPToolOutput);
  return {
    chars: output.length + String(hook.additionalContext || "").length,
    output,
    context: String(hook.additionalContext || ""),
  };
}

function failureArm(hook, arm) {
  const session = `guardrail-failure-${arm}-${process.pid}`;
  const error = [
    "Error: deterministic build worker failed with locked cache state",
    ...Array.from({ length: 420 }, (_, index) =>
      `at worker_${index} (src/generated/module-${index}.js:${index + 10}:${index + 20}) code=LOCK_${index}`
    ),
    "FAILED: deterministic build worker",
  ].join("\n");
  const input = {
    tool_name: "functions.shell_command",
    tool_input: { command: "npm test -- --runInBand" },
    tool_output: error,
    is_error: true,
    cwd: pluginRoot,
    session_id: session,
  };
  hook.handle("posttooluse", input);
  const pre = hook.handle("pretooluse", input);
  const second = visible(hook.handle("posttooluse", input), error);
  const changed = visible(hook.handle("posttooluse", {
    ...input,
    tool_output: `${error}\nError: NEW-EVIDENCE-${arm}`,
  }), `${error}\nError: NEW-EVIDENCE-${arm}`);
  return {
    raw_chars: error.length,
    repeated_visible_chars: second.chars + String(pre?.hookSpecificOutput?.additionalContext || "").length,
    retry_warning: /retry fuse|already failed/i.test(String(pre?.hookSpecificOutput?.additionalContext || "")),
    exact_recovery: /exact=cap_[a-f0-9]{16}/i.test(second.output),
    changed_evidence_not_suppressed: !/repeated failure/i.test(changed.output),
  };
}

function planArm(hook, arm) {
  const session = `guardrail-plan-${arm}-${process.pid}`;
  const plan = {
    tool_name: "functions.update_plan",
    tool_input: {
      plan: [
        { step: "Inspect failure", status: "completed" },
        { step: "Apply fix", status: "in_progress" },
      ],
    },
    cwd: pluginRoot,
    session_id: session,
  };
  hook.handle("pretooluse", plan);
  hook.handle("posttooluse", { ...plan, tool_output: "Plan updated" });
  const repeated = hook.handle("pretooluse", plan);
  const detected = /plan fuse|same plan|plan-only loop/i.test(
    String(repeated?.hookSpecificOutput?.additionalContext || "")
  );
  const mutation = {
    tool_name: "functions.apply_patch",
    tool_input: { patch: "*** Update File: src/example.js\n+fixed\n" },
    tool_output: "Done",
    cwd: pluginRoot,
    session_id: session,
  };
  hook.handle("pretooluse", mutation);
  hook.handle("posttooluse", mutation);
  const afterMutation = hook.handle("pretooluse", plan);
  return {
    repeated_plan_detected: detected,
    normal_plan_after_mutation_flagged: /plan fuse|same plan|plan-only loop/i.test(
      String(afterMutation?.hookSpecificOutput?.additionalContext || "")
    ),
  };
}

function saving(before, after) {
  return before > 0 ? Number(((before - after) / before * 100).toFixed(2)) : 0;
}

const baseline = baselineRoot();
const baselineHook = require(path.join(baseline, "scripts", "hook.cjs"));
const treatmentHook = require("../scripts/hook.cjs");
const baselineUnified = require(path.join(baseline, "mcp", "unified.cjs"));
const treatmentUnified = require("../mcp/unified.cjs");

const routingCases = [
  {
    id: "observed-control-plane-false-positive",
    query: "improve universal Codex token and quota efficiency after v0.18 by researching user pain, detecting wasted model turns, implementing safe automatic controls, benchmarking real sessions, and reinstalling the plugin",
    expected: null,
  },
  {
    id: "compaction-control-plane",
    query: "measure automatic context compaction token savings in another Codex thread using session telemetry",
    expected: null,
  },
  {
    id: "website-security-name-collision",
    query: "clone a live website into responsive frontend code",
    expected: null,
  },
  {
    id: "gmail-triage-name-collision",
    query: "manage Gmail inbox triage",
    expected: null,
  },
  {
    id: "direct-spreadsheet-skill",
    query: "analyze spreadsheet formulas and financial workbook",
    expected: null,
  },
  {
    id: "direct-presentation-skill",
    query: "create a PowerPoint presentation deck",
    expected: null,
  },
  {
    id: "specific-session-security-task",
    query: "hunt session management vulnerabilities and session fixation",
    expected: "hunt-session",
  },
  {
    id: "specific-sqli-security-task",
    query: "find SQL injection vulnerabilities in an API",
    expected: "hunt-sqli",
  },
  {
    id: "specific-oauth-security-task",
    query: "test OAuth authorization bypass vulnerabilities",
    expected: "hunt-oauth",
  },
];

try {
  const routing = routingCases.map((item) => {
    const before = route(baseline, item.query);
    const after = route(pluginRoot, item.query);
    const beforeName = before.matches?.[0]?.name || null;
    const afterName = after.matches?.[0]?.name || null;
    return {
      id: item.id,
      expected: item.expected,
      baseline: beforeName,
      treatment: afterName,
      baseline_correct: beforeName === item.expected,
      treatment_correct: afterName === item.expected,
      baseline_wrong_skill_body_chars: item.expected == null && beforeName ? selectedBodyChars(before) : 0,
      treatment_wrong_skill_body_chars: item.expected == null && afterName ? selectedBodyChars(after) : 0,
    };
  });
  const baselineFailure = failureArm(baselineHook, "baseline");
  const treatmentFailure = failureArm(treatmentHook, "treatment");
  const baselinePlan = planArm(baselineHook, "baseline");
  const treatmentPlan = planArm(treatmentHook, "treatment");
  const baselineRouteWaste = routing.reduce((sum, row) => sum + row.baseline_wrong_skill_body_chars, 0);
  const treatmentRouteWaste = routing.reduce((sum, row) => sum + row.treatment_wrong_skill_body_chars, 0);
  const before = baselineRouteWaste + baselineFailure.repeated_visible_chars;
  const after = treatmentRouteWaste + treatmentFailure.repeated_visible_chars;
  const report = {
    method: {
      baseline,
      treatment: pluginRoot,
      routing_dataset: "Nine local task intents: two control-plane negatives, two observed domain/name collisions, two direct-skill negatives, and three positive security controls.",
      failure_dataset: "One deterministic 420-frame repeated error; first occurrences cancel, changed evidence is a safety control.",
      plan_dataset: "One unchanged repeated plan plus a real-mutation reset control.",
      accounting: "Model-visible character proxy for wrong routed SKILL.md bodies and the second identical failure. Plan-loop detection is reported separately, not converted into speculative tokens.",
      caveat: "This is a targeted waste-event A/B, not an all-task billing percentage.",
    },
    routing: {
      cases: routing,
      baseline_accuracy_percent: saving(routing.length, routing.filter((row) => !row.baseline_correct).length),
      treatment_accuracy_percent: saving(routing.length, routing.filter((row) => !row.treatment_correct).length),
      wrong_skill_body_chars_avoided: baselineRouteWaste - treatmentRouteWaste,
      wrong_skill_body_approx_text_tokens_avoided: Math.max(0, Math.ceil((baselineRouteWaste - treatmentRouteWaste) / 4)),
    },
    repeated_failure: {
      baseline: baselineFailure,
      treatment: treatmentFailure,
      repeated_visible_saving_percent: saving(
        baselineFailure.repeated_visible_chars,
        treatmentFailure.repeated_visible_chars
      ),
    },
    plan_progress: {
      baseline: baselinePlan,
      treatment: treatmentPlan,
    },
    combined_measured_waste_events: {
      baseline_visible_chars: before,
      treatment_visible_chars: after,
      avoided_chars: before - after,
      avoided_approx_text_tokens: Math.max(0, Math.ceil((before - after) / 4)),
      saving_percent: saving(before, after),
    },
  };
  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  const write = argument("--write");
  if (write) fs.writeFileSync(path.resolve(write), rendered, "utf8");
  process.stdout.write(rendered);
  if (
    report.routing.treatment_accuracy_percent !== 100 ||
    !treatmentFailure.exact_recovery ||
    !treatmentFailure.changed_evidence_not_suppressed ||
    !treatmentPlan.repeated_plan_detected ||
    treatmentPlan.normal_plan_after_mutation_flagged
  ) {
    process.exitCode = 1;
  }
} finally {
  baselineUnified.closeSearchDatabase();
  treatmentUnified.closeSearchDatabase();
  fs.rmSync(state, { recursive: true, force: true });
}
