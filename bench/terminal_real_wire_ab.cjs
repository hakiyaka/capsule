"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-terminal-real-wire-"));
process.env.CAPSULE_STATE = path.join(stateRoot, "state");
const core = require("../mcp/core.cjs");
const hookScript = path.join(projectRoot, "scripts", "hook.cjs");

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const codex = process.platform === "win32" ? "codex.cmd" : "codex";
const testFiles = fs.readdirSync(path.join(projectRoot, "tests"))
  .filter((file) => file.endsWith(".test.cjs"))
  .sort()
  .map((file) => path.join("tests", file));
const inventoryCode = [
  "const fs=require('node:fs'),path=require('node:path');",
  "const out=[];",
  "function walk(p){for(const e of fs.readdirSync(p,{withFileTypes:true})){const q=path.join(p,e.name);",
  "if(e.isDirectory())walk(q);else{const s=fs.statSync(q);out.push(q+'\\t'+s.size+'\\t'+s.mtime.toISOString())}}}",
  "walk('mcp');walk('scripts');console.log(out.sort().join('\\n'));",
].join("");
const mcpInventoryCode = inventoryCode.replace(
  "walk('mcp');walk('scripts');",
  "walk('mcp');"
);
const warmAugmentedInventoryCode = mcpInventoryCode.replace(
  "console.log(out.sort().join('\\n'));",
  "const s=fs.statSync('package.json');out.push('package.json\\t'+s.size+'\\t'+s.mtime.toISOString());" +
  "console.log(out.sort().join('\\n'));"
);
const hashCode = [
  "const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');",
  "for(const d of ['mcp','scripts'])for(const f of fs.readdirSync(d).sort()){const p=path.join(d,f);",
  "if(fs.statSync(p).isFile()){const b=fs.readFileSync(p);",
  "console.log(p+'\\t'+crypto.createHash('sha256').update(b).digest('hex')+'\\t'+b.length)}}",
].join("");
const performanceCode = "for(let i=0;i<120;i++)console.log('sample '+i+' latency '+(i+1)+'ms')";
const failureCode = "for(let i=0;i<80;i++)console.error('error '+i+' retained failure evidence');process.exit(2)";

const scenarios = [
  {
    id: "real-source-inventory",
    command: "node source file inventory",
    executable: process.execPath,
    args: ["-e", inventoryCode],
  },
  {
    id: "real-source-hashes",
    command: "node source hashes",
    executable: process.execPath,
    args: ["-e", hashCode],
  },
  {
    id: "real-warm-mcp-inventory",
    session: "real-wire-warm-inventory",
    command: "node mcp file inventory",
    executable: process.execPath,
    args: ["-e", mcpInventoryCode],
  },
  {
    id: "real-warm-augmented-inventory",
    session: "real-wire-warm-inventory",
    command: "node mcp plus package file inventory",
    executable: process.execPath,
    args: ["-e", warmAugmentedInventoryCode],
  },
  {
    id: "real-symbol-search",
    command: "rg -n function mcp scripts",
    executable: "rg",
    args: ["-n", "function ", "mcp", "scripts"],
  },
  {
    id: "real-focused-tests",
    command: "node --test tests/terminal-novelty.test.cjs",
    executable: process.execPath,
    args: ["--test", "tests/terminal-novelty.test.cjs"],
  },
  {
    id: "real-full-tests",
    command: "node --test all test files",
    executable: process.execPath,
    args: ["--test", "--test-reporter=dot", ...testFiles],
    timeout_ms: 180_000,
  },
  {
    id: "real-hook-status",
    command: "node scripts/install-hooks.cjs status",
    executable: process.execPath,
    args: ["scripts/install-hooks.cjs", "status"],
  },
  {
    id: "real-plugin-list",
    command: "codex plugin list --json",
    executable: codex,
    args: ["plugin", "list", "--json"],
  },
  {
    id: "real-runtime-version",
    command: "node runtime versions",
    executable: process.execPath,
    args: ["-e", "console.log(JSON.stringify(process.versions,null,2))"],
  },
  {
    id: "real-npm-version",
    command: "npm --version",
    executable: npm,
    args: ["--version"],
  },
  {
    id: "short-output-control",
    command: "node short output",
    executable: process.execPath,
    args: ["-e", "console.log('ok')"],
  },
  {
    id: "failed-output-control",
    command: "node failing diagnostic",
    executable: process.execPath,
    args: ["-e", failureCode],
    must_passthrough: true,
  },
  {
    id: "literal-performance-control",
    command: "benchmark latency --full-output",
    executable: process.execPath,
    args: ["-e", performanceCode],
    must_passthrough: true,
  },
  {
    id: "literal-verbatim-control",
    command: "show exact full output verbatim",
    executable: process.execPath,
    args: ["-e", inventoryCode],
    must_passthrough: true,
  },
];

function runScenario(scenario) {
  const started = Date.now();
  const commandEnvironment = { ...process.env };
  delete commandEnvironment.CAPSULE_STATE;
  delete commandEnvironment.CAPSULE_REASONING_GOVERNOR;
  delete commandEnvironment.CAPSULE_COGNITION;
  const child = spawnSync(scenario.executable, scenario.args, {
    cwd: projectRoot,
    env: commandEnvironment,
    encoding: "utf8",
    timeout: scenario.timeout_ms || 60_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(scenario.executable),
  });
  if (child.error && child.error.code !== "ETIMEDOUT") {
    return {
      ...scenario,
      skipped: true,
      skip_reason: child.error.code || child.error.message || "spawn-error",
    };
  }
  const exitCode = Number.isInteger(child.status) ? child.status : 124;
  const stdout = child.stdout || "";
  const stderr = child.stderr || "";
  const body = (stdout + (stdout && stderr ? "\n" : "") + stderr).trimEnd();
  const elapsed = Date.now() - started;
  const original = [
    "Exit code: " + exitCode,
    "Wall time: " + (elapsed / 1000).toFixed(3) + " seconds",
    "Output:",
    body,
  ].join("\n");
  const input = {
    tool_name: "shell_command",
    session_id: (scenario.session || "real-wire-" + scenario.id) + "-" + process.pid,
    cwd: projectRoot,
    tool_input: { command: scenario.command },
    tool_output: original,
    is_error: exitCode !== 0,
  };
  const hookEnvironment = {
    ...process.env,
    CAPSULE_STATE: process.env.CAPSULE_STATE,
    CAPSULE_REASONING_GOVERNOR: "0",
    CAPSULE_COGNITION: "0",
  };
  const hookChild = spawnSync(process.execPath, ["--no-warnings", hookScript, "posttooluse"], {
    cwd: projectRoot,
    env: hookEnvironment,
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  let hookResult = {};
  let hookProcessValid = hookChild.status === 0;
  try {
    hookResult = JSON.parse(hookChild.stdout || "{}");
  } catch {
    hookProcessValid = false;
  }
  const replacement = hookResult?.continue === false && typeof hookResult.reason === "string"
    ? hookResult.reason
    : original;
  const exactId = replacement.match(/\bexact=(cap_[0-9a-f]+)\b/)?.[1] || "";
  const strippedEnvelope = body || "[Capsule exec ok; no output]";
  let exactRecovery = replacement === original || replacement === strippedEnvelope;
  if (exactId) {
    try {
      exactRecovery = core.loadCapsule(exactId).text === original;
    } catch {
      exactRecovery = false;
    }
  }
  const route = replacement === original
    ? "passthrough"
    : /terminal lattice/.test(replacement)
    ? "terminal-lattice"
    : /terminal genome/.test(replacement)
    ? "terminal-genome"
    : replacement === strippedEnvelope
    ? "control-envelope"
    : "other-exact-compression";
  const criticalLines = original.split(/\r?\n/).filter((line) =>
    /\b(?:error|fail(?:ed|ure)?|exception|panic|fatal|warning|warn|denied|conflict|timeout|timed out)\b/i.test(line)
  );
  const criticalVisible = route !== "terminal-lattice" ||
    criticalLines.every((line) => replacement.includes(line));
  const wireValid = hookProcessValid && (replacement === original || Boolean(
    hookResult?.continue === false &&
    hookResult?.hookSpecificOutput?.hookEventName === "PostToolUse" &&
    hookResult.reason === replacement
  ));
  const passthroughValid = !scenario.must_passthrough || replacement === original;
  return {
    id: scenario.id,
    exit_code: exitCode,
    route,
    original,
    treatment: replacement,
    raw_chars: original.length,
    emitted_chars: replacement.length,
    exact_recovery: exactRecovery,
    critical_visible: criticalVisible,
    hook_process_valid: hookProcessValid,
    wire_valid: wireValid,
    passthrough_valid: passthroughValid,
    oracle: exactRecovery && criticalVisible && wireValid && passthroughValid,
  };
}

function tokenize(values) {
  const code = [
    "import json,sys,tiktoken",
    "values=json.load(sys.stdin)",
    "enc=tiktoken.get_encoding('o200k_base')",
    "print(json.dumps([len(enc.encode(str(value))) for value in values]))",
  ].join("\n");
  const child = spawnSync(process.env.PYTHON || "python", ["-c", code], {
    input: JSON.stringify(values),
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  if (child.status === 0) return { exact: true, counts: JSON.parse(child.stdout) };
  return { exact: false, counts: values.map(core.estimateTokens) };
}

const rows = scenarios.map(runScenario);
const measured = rows.filter((row) => !row.skipped);
const tokenized = tokenize([
  ...measured.map((row) => row.original),
  ...measured.map((row) => row.treatment),
]);
for (let index = 0; index < measured.length; index += 1) {
  measured[index].control_tokens = tokenized.counts[index];
  measured[index].treatment_tokens = tokenized.counts[index + measured.length];
  measured[index].savings_percent = Number(
    (((measured[index].control_tokens - measured[index].treatment_tokens) /
      Math.max(1, measured[index].control_tokens)) * 100).toFixed(2)
  );
  delete measured[index].original;
  delete measured[index].treatment;
}
const controlTokens = measured.reduce((sum, row) => sum + row.control_tokens, 0);
const treatmentTokens = measured.reduce((sum, row) => sum + row.treatment_tokens, 0);
const activated = measured.filter((row) => row.route !== "passthrough");
const activatedControl = activated.reduce((sum, row) => sum + row.control_tokens, 0);
const activatedTreatment = activated.reduce((sum, row) => sum + row.treatment_tokens, 0);
const terminalActivated = measured.filter((row) => /^terminal-/.test(row.route));
const terminalControl = terminalActivated.reduce((sum, row) => sum + row.control_tokens, 0);
const terminalTreatment = terminalActivated.reduce((sum, row) => sum + row.treatment_tokens, 0);
const routeCounts = Object.fromEntries(
  [...new Set(measured.map((row) => row.route))].sort().map((route) => [
    route,
    measured.filter((row) => row.route === route).length,
  ])
);
const report = {
  benchmark: "terminal-real-wire-ab",
  generated_at: new Date().toISOString(),
  task_set: "Read-only commands executed against the real Capsule checkout, plus short, failed, performance, and verbatim negative controls.",
  scenarios: measured.length,
  skipped: rows.filter((row) => row.skipped).map((row) => ({ id: row.id, reason: row.skip_reason })),
  routes: routeCounts,
  oracles_passed: measured.filter((row) => row.oracle).length + "/" + measured.length,
  tokenizer: tokenized.exact ? "o200k_base" : "estimate",
  control_tokens: controlTokens,
  treatment_tokens: treatmentTokens,
  savings_percent: Number((((controlTokens - treatmentTokens) / Math.max(1, controlTokens)) * 100).toFixed(2)),
  activated_control_tokens: activatedControl,
  activated_treatment_tokens: activatedTreatment,
  activated_savings_percent: Number(
    (((activatedControl - activatedTreatment) / Math.max(1, activatedControl)) * 100).toFixed(2)
  ),
  terminal_activated_scenarios: terminalActivated.length,
  terminal_control_tokens: terminalControl,
  terminal_treatment_tokens: terminalTreatment,
  terminal_savings_percent: Number(
    (((terminalControl - terminalTreatment) / Math.max(1, terminalControl)) * 100).toFixed(2)
  ),
  rows: measured,
  caveat: "Local contract-valid model-visible output measurement. It excludes hidden prompts, hidden reasoning, provider caching, subscription quotas, and host-side billing.",
};
const output = JSON.stringify(report, null, 2);
const writeIndex = process.argv.indexOf("--write");
if (writeIndex >= 0 && process.argv[writeIndex + 1]) {
  fs.writeFileSync(path.resolve(process.argv[writeIndex + 1]), output + "\n", "utf8");
}
process.stdout.write(output + "\n");
if (measured.some((row) => !row.oracle)) process.exitCode = 1;
process.on("exit", () => fs.rmSync(stateRoot, { recursive: true, force: true }));
