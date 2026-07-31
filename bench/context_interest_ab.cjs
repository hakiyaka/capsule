"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-context-interest-bench-"));
process.env.CAPSULE_STATE = state;
const hook = require("../scripts/hook.cjs");

function pressureFile(input, cached, contextWindow, compactions) {
  const file = path.join(state, `pressure-${input}-${cached}-${compactions}.jsonl`);
  const records = [];
  for (let index = 0; index < compactions; index += 1) {
    records.push({ timestamp: new Date().toISOString(), type: "compacted", payload: {} });
  }
  records.push({
    timestamp: new Date().toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        model_context_window: contextWindow,
        last_token_usage: {
          input_tokens: input,
          cached_input_tokens: cached,
          output_tokens: 100,
          reasoning_output_tokens: 20,
          total_tokens: input + 100,
        },
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: 0,
          output_tokens: 100,
          reasoning_output_tokens: 20,
          total_tokens: input + 100,
        },
      },
    },
  });
  fs.writeFileSync(file, `${records.map(JSON.stringify).join("\n")}\n`, "utf8");
  return file;
}

const cases = [
  [92_000, 70_000, 100_000, 2], [180_000, 140_000, 200_000, 1],
  [240_000, 190_000, 258_000, 2], [125_000, 80_000, 140_000, 1],
  [70_000, 45_000, 80_000, 3], [210_000, 170_000, 230_000, 2],
  [150_000, 100_000, 165_000, 1], [96_000, 60_000, 105_000, 2],
  [230_000, 180_000, 250_000, 2], [115_000, 75_000, 125_000, 1],
];
const requestedSingletons = 16;
const rows = [];
let baseline = 0;
let exchange = 0;

for (const [index, [input, cached, window, compactions]] of cases.entries()) {
  const sessionFile = pressureFile(input, cached, window, compactions);
  const weighted = input - cached + cached * 0.1;
  let gateAt = requestedSingletons;
  for (let call = 1; call <= requestedSingletons; call += 1) {
    const result = hook.handle("pretooluse", {
      tool_name: "workspace.read_file",
      tool_input: { path: path.join(state, `case-${index}-file-${call}.txt`) },
      cwd: state,
      session_id: `interest-case-${index}`,
      session_file: sessionFile,
    });
    if (result.hookSpecificOutput?.permissionDecision === "deny") {
      gateAt = call;
      break;
    }
  }
  const baselineRounds = requestedSingletons;
  const exchangeRounds = Math.min(requestedSingletons, gateAt + 1);
  baseline += baselineRounds * weighted;
  exchange += exchangeRounds * weighted;
  rows.push({ input, cached, weighted, baseline_rounds: baselineRounds, exchange_rounds: exchangeRounds, gate_at: gateAt });
}

const result = {
  cases: rows.length,
  requested_singleton_rounds_per_case: requestedSingletons,
  baseline_weighted_context_tokens: Math.round(baseline),
  exchange_weighted_context_tokens: Math.round(exchange),
  projected_roundtrip_context_savings_percent: Number(((1 - exchange / baseline) * 100).toFixed(2)),
  conservative_note: "Counts the denied attempt and one replacement batch round; excludes tool-output savings.",
  rows,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
const writeIndex = process.argv.indexOf("--write");
if (writeIndex >= 0 && process.argv[writeIndex + 1]) {
  fs.writeFileSync(path.resolve(process.argv[writeIndex + 1]), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
fs.rmSync(state, { recursive: true, force: true });
