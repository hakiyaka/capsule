"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const core = require("../mcp/core.cjs");
const unified = require("../mcp/unified.cjs");
const { terminalNovelty } = require("../mcp/terminal-novelty.cjs");

const commands = [
  "npm test", "pnpm lint", "tsc --noEmit", "npm run build", "prettier --check .",
  "git status --short", "git diff --stat", "rg -n TODO src", "Get-ChildItem -Recurse", "npm audit",
];

function outputFor(command, run) {
  const stable = Array.from({ length: 260 }, (_, index) =>
    `${command}: module-${crypto.createHash("sha1").update(`${command}-${index}`).digest("hex").slice(0, 10)} ` +
    `passed via worker-${String.fromCharCode(97 + (index % 26))} in ${10 + index + run}ms`
  );
  return `# stdout\n${stable.join("\n")}\n${run ? "ERROR fixed-path changed to warning" : "ERROR old-path failed"}\n# stderr\n`;
}

const rows = [];
let baselineTokens = 0;
let noveltyTokens = 0;
let rawTokens = 0;
for (const [index, command] of commands.entries()) {
  const session = `terminal-benchmark-${process.pid}-${Date.now()}-${index}`;
  for (let run = 0; run < 3; run += 1) {
    const text = outputFor(command, run);
    const saved = core.saveCapsule({
      kind: "terminal-benchmark",
      source: command,
      text,
      maxChars: 1_200,
    }).response;
    const compressed = unified.compressText(text, {
      command,
      max_chars: 1_200,
      passthrough_chars: 300,
    });
    const baseline = compressed.route === "compressed"
      ? `${compressed.output}\n[exact=${saved.capsule_id}]`
      : text;
    const novelty = terminalNovelty({
      session_id: session,
      cwd: process.cwd(),
      command,
      text,
      capsule_id: saved.capsule_id,
      baseline_output: baseline,
    });
    if (run > 0) {
      rawTokens += core.estimateTokens(text);
      baselineTokens += core.estimateTokens(baseline);
      noveltyTokens += core.estimateTokens(novelty?.output || baseline);
      rows.push({ command, run, baseline_chars: baseline.length, novelty_chars: (novelty?.output || baseline).length });
    }
  }
}

const result = {
  cases: rows.length,
  raw_tokens: rawTokens,
  baseline_tokens: baselineTokens,
  novelty_tokens: noveltyTokens,
  savings_vs_raw_percent: Number(((1 - noveltyTokens / rawTokens) * 100).toFixed(2)),
  incremental_savings_vs_existing_compressor_percent:
    Number(((1 - noveltyTokens / baselineTokens) * 100).toFixed(2)),
  rows,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
const writeIndex = process.argv.indexOf("--write");
if (writeIndex >= 0 && process.argv[writeIndex + 1]) {
  fs.writeFileSync(path.resolve(process.argv[writeIndex + 1]), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}
