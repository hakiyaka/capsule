"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-zero-inference-poll-ab-"));
process.env.CAPSULE_STATE = path.join(root, "state");
process.env.CAPSULE_ZERO_POLL_WINDOW_MS = "20000";
process.env.CAPSULE_ZERO_POLL_INTERVAL_MS = "4000";
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace, { recursive: true });

const core = require("../mcp/core.cjs");
const hookCli = require("../scripts/cli.cjs");

const families = [
  {
    name: "github-actions",
    command: "gh run view 123",
    profile: "git",
    pending: "workflow=ci status=pending conclusion=\n",
    changed: "workflow=ci status=completed conclusion=success\n",
    oracle: "conclusion=success",
  },
  {
    name: "kubernetes",
    command: "kubectl get pod checkout-7f9",
    profile: "table",
    pending: "NAME READY STATUS RESTARTS\ncheckout-7f9 0/1 Pending 0\n",
    changed: "NAME READY STATUS RESTARTS\ncheckout-7f9 1/1 Running 0\n",
    oracle: "1/1 Running",
  },
  {
    name: "git-worktree",
    command: "git status --short",
    profile: "git",
    pending: " M src/worker.cjs\n",
    changed: " M src/worker.cjs\n M tests/worker.test.cjs\n",
    oracle: "tests/worker.test.cjs",
  },
];

function executorFor(family, changesAt) {
  let calls = 0;
  return {
    execute: async () => {
      calls += 1;
      return {
        exit_code: 0,
        signal: null,
        stdout: calls >= changesAt ? family.changed : family.pending,
        stderr: "",
      };
    },
    calls: () => calls,
  };
}

function tokenize(items) {
  const code = [
    "import json,sys,tiktoken",
    "x=json.load(sys.stdin)",
    "e=tiktoken.get_encoding('o200k_base')",
    "print(json.dumps([len(e.encode(str(v))) for v in x]))",
  ].join("\n");
  const child = spawnSync(process.env.PYTHON || "python", ["-c", code], {
    input: JSON.stringify(items),
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  if (child.status === 0) return { exact: true, counts: JSON.parse(child.stdout) };
  return { exact: false, counts: items.map(core.estimateTokens) };
}

function percent(before, after) {
  return Number((((before - after) / Math.max(1, before)) * 100).toFixed(2));
}

async function main() {
  const contexts = [8_000, 32_000, 96_000, 160_000, 240_000];
  const artifacts = [];
  for (const family of families) {
    for (let index = 0; index < contexts.length; index += 1) {
      const context = contexts[index];
      const common = {
        cwd: workspace,
        execution_epoch: 1,
        input_tokens: context,
        command: family.command,
        profile: family.profile,
        max_chars: 1_200,
        passthrough_chars: 500,
      };

      process.env.CAPSULE_ZERO_POLL = "0";
      const controlExecutor = executorFor(family, 5);
      const control = [];
      for (let call = 0; call < 5; call += 1) {
        const result = await hookCli.runPayload({
          ...common,
          session_id: `zero-poll-control-${family.name}-${index}`,
        }, controlExecutor.execute);
        control.push(result.output);
      }

      process.env.CAPSULE_ZERO_POLL = "1";
      const treatmentSession = `zero-poll-treatment-${family.name}-${index}`;
      await hookCli.runPayload({
        ...common,
        session_id: treatmentSession,
      }, async () => ({
        exit_code: 0,
        signal: null,
        stdout: family.pending,
        stderr: "",
      }));
      const treatmentExecutor = executorFor(family, 5);
      const treatment = await hookCli.runPayload({
        ...common,
        session_id: treatmentSession,
      }, treatmentExecutor.execute, {
        sleep: async () => {},
        waitForSignal: async () => ({ kind: "event" }),
      });
      const exact = treatment.proof
        ? JSON.parse(core.loadCapsule(treatment.proof).text)
        : null;
      artifacts.push({
        family: family.name,
        context,
        control,
        treatment: treatment.output,
        control_calls: controlExecutor.calls(),
        treatment_calls: treatmentExecutor.calls(),
        local_observations: treatment.poll?.local_observations || 0,
        oracle: Boolean(
          control.at(-1).includes(family.oracle) &&
          treatment.output.includes(family.oracle) &&
          treatment.poll?.changed === true &&
          exact?.probes?.at(-1)?.changed === true
        ),
      });
    }
  }

  const strings = artifacts.flatMap((item) => [...item.control, item.treatment]);
  const tokenized = tokenize(strings);
  let cursor = 0;
  const rows = artifacts.map((item) => {
    const controlTokens = item.control.map(() => tokenized.counts[cursor++]);
    const treatmentTokens = tokenized.counts[cursor++];
    let cumulative = 0;
    let controlInput = 0;
    for (const count of controlTokens) {
      cumulative += count;
      controlInput += item.context + cumulative;
    }
    const treatmentInput = item.context + treatmentTokens;
    return {
      family: item.family,
      context_tokens: item.context,
      oracle: item.oracle,
      control_model_reentries: 5,
      treatment_model_reentries: 1,
      local_observations: item.local_observations,
      control_visible_tokens: controlTokens.reduce((sum, value) => sum + value, 0),
      treatment_visible_tokens: treatmentTokens,
      input_exposure_savings_percent: percent(controlInput, treatmentInput),
    };
  });
  const sum = (field) => rows.reduce((total, row) => total + Number(row[field] || 0), 0);
  const report = {
    benchmark: "zero-inference-poll-reactor-ab",
    generated_at: new Date().toISOString(),
    method: {
      task_set: "15 warm-state status-wait scenarios: GitHub Actions, Kubernetes, and Git worktree across five context sizes.",
      arm_a: "Five unchanged/change status results, each followed by a separate model re-entry.",
      arm_b: "One repeated status invocation; four bounded local observations are coalesced before one model re-entry.",
      warmup: "One identical successful observation precedes both measured arms and is excluded from both.",
      oracle: "Both arms must expose the same terminal semantic state; every local observation remains exactly capsule-recoverable.",
      tokenizer: tokenized.exact ? "o200k_base" : "estimate",
    },
    scenarios: rows.length,
    oracles_passed: `${rows.filter((row) => row.oracle).length}/${rows.length}`,
    model_reentry_reduction_percent: percent(
      sum("control_model_reentries"),
      sum("treatment_model_reentries")
    ),
    visible_result_change_percent: percent(
      sum("control_visible_tokens"),
      sum("treatment_visible_tokens")
    ),
    average_input_exposure_savings_percent: Number(
      (rows.reduce((total, row) => total + row.input_exposure_savings_percent, 0) / rows.length).toFixed(2)
    ),
    rows,
    caveat: "Warm-state deterministic polling benchmark. It measures model-visible post-tool input exposure, not provider billing, cache pricing, hidden reasoning, subscription weighting, or the probability that a user/model would have continued polling for the full horizon.",
  };
  const output = JSON.stringify(report, null, 2);
  const writeIndex = process.argv.indexOf("--write");
  if (writeIndex >= 0 && process.argv[writeIndex + 1]) {
    fs.writeFileSync(path.resolve(process.argv[writeIndex + 1]), `${output}\n`, "utf8");
  }
  process.stdout.write(`${output}\n`);
  if (rows.some((row) => !row.oracle)) process.exitCode = 1;
}

main().finally(() => {
  delete process.env.CAPSULE_ZERO_POLL;
  delete process.env.CAPSULE_ZERO_POLL_WINDOW_MS;
  delete process.env.CAPSULE_ZERO_POLL_INTERVAL_MS;
  fs.rmSync(root, { recursive: true, force: true });
});
