"use strict";

const fs = require("node:fs");
const path = require("node:path");
const unified = require("../mcp/unified.cjs");

async function main() {
  const plan = (await unified.dispatch({
    action: "skills",
    payload: { operation: "airlock-plan" },
  })).response;
  const baselinePerRequest = plan.estimated_static_metadata_tokens_per_request;
  const airlockPerRequest = plan.estimated_airlock_anchor_tokens_per_request;
  const cycles = [1, 4, 10, 20, 40];
  const rows = cycles.map((requests) => ({
    model_requests: requests,
    static_catalog_tokens: baselinePerRequest * requests,
    capability_airlock_tokens: airlockPerRequest * requests,
    tokens_avoided: (baselinePerRequest - airlockPerRequest) * requests,
  }));
  const result = {
    active_skill_frontmatters: plan.skills,
    measured_metadata_chars: plan.metadata_chars,
    static_catalog_tokens_per_request: baselinePerRequest,
    airlock_anchor_tokens_per_request: airlockPerRequest,
    static_catalog_component_savings_percent:
      Number(((1 - airlockPerRequest / Math.max(1, baselinePerRequest)) * 100).toFixed(2)),
    scope_note: "Measures the recurring skill-catalog component only. Selected skill bodies are on-demand in both conditions.",
    rows,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  const writeIndex = process.argv.indexOf("--write");
  if (writeIndex >= 0 && process.argv[writeIndex + 1]) {
    fs.writeFileSync(path.resolve(process.argv[writeIndex + 1]), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}).finally(() => unified.closeSearchDatabase());
