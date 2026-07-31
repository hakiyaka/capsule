"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../mcp/core.cjs");
const schema = require("../mcp/schema.cjs");

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-ab-"));
process.env.CAPSULE_STATE = path.join(temporary, "state");
const cases = [];
const policyThreshold = Number(process.env.CAPSULE_POLICY_THRESHOLD || 1536);
const evidenceBudget = Number(process.env.CAPSULE_BENCH_MAX_CHARS || 800);

function addCase({ name, category, prompt, query = "", baseline, treatment, route, invoked, expected = [], selection = "measured" }) {
  cases.push({ name, category, prompt, query, baseline, treatment, route, invoked, expected, selection });
}

function bypass(name, category, prompt, baseline, reason) {
  addCase({
    name,
    category,
    prompt,
    baseline,
    treatment: baseline,
    route: `bypass:${reason}`,
    invoked: false,
    selection: "not-applicable",
  });
}

function fileCase({ name, category, prompt, text, question, expected, mode = "auto" }) {
  const file = path.join(temporary, `${name}.txt`);
  fs.writeFileSync(file, text, "utf8");
  const operation = core.smartFile({
    path: file,
    question,
    mode,
    max_chars: evidenceBudget,
    passthrough_chars: policyThreshold,
  });
  if (operation.route === "lossless" && core.decodeLineDictionary(core.renderOperation(operation)) !== operation.baselineText) {
    throw new Error(`Lossless verification failed for ${name}`);
  }
  addCase({
    name,
    category,
    prompt,
    query: question,
    baseline: operation.baselineText,
    treatment: core.renderOperation(operation),
    route: operation.route,
    invoked: operation.route !== "passthrough",
    expected,
    selection: operation.route === "passthrough" ? "measured-safe-bypass" : "measured-transform",
  });
}

function commandCase({ name, category, prompt, args, question, expected }) {
  const operation = core.smartCommand({
    command: process.execPath,
    args,
    question,
    max_chars: evidenceBudget,
  });
  addCase({
    name,
    category,
    prompt,
    query: question,
    baseline: operation.baselineText,
    treatment: core.renderOperation(operation),
    route: operation.route,
    invoked: operation.route !== "passthrough",
    expected,
    selection: operation.route === "passthrough" ? "measured-safe-bypass" : "measured-transform",
  });
}

bypass(
  "tiny-chat-answer",
  "reasoning",
  "What is 2+2? Answer with only the number.",
  "4",
  "no-external-evidence"
);

bypass(
  "long-form-writing",
  "writing",
  "Write a careful product positioning paragraph from the facts already in the conversation.",
  "A concise answer generated from existing context; no new local evidence is loaded.",
  "no-external-evidence"
);

bypass(
  "image-editing",
  "media",
  "Remove the background from the attached image.",
  "The specialized image tool result is used directly.",
  "specialized-binary-tool"
);

bypass(
  "spreadsheet-editing",
  "structured-artifact",
  "Change the formula in B12 and preserve workbook formatting.",
  "The spreadsheet runtime edits the workbook without routing binary content through this plugin.",
  "specialized-artifact-tool"
);

fileCase({
  name: "tiny-config-lookup",
  category: "small-file",
  prompt: "Read the timeout value.",
  text: "host=localhost\ntimeout=30\nretries=2\n",
  question: "timeout",
  expected: ["timeout=30"],
});

fileCase({
  name: "small-source-full-edit",
  category: "editing",
  prompt: "Rename every variable in this complete file.",
  text: `${"const value = 1;\n".repeat(300)}module.exports = value;\n`,
  question: "rename every variable",
  expected: [],
  mode: "full",
});

const uniqueFullText = Array.from(
  { length: 5000 },
  (_, index) => `unique-${index}-${((index * 2654435761) >>> 0).toString(36)} carries distinct semantics\n`
).join("");
fileCase({
  name: "unique-large-full-edit",
  category: "editing",
  prompt: "Transform every distinct line; the complete unique source is required.",
  text: uniqueFullText,
  question: "transform every distinct line",
  expected: ["unique-4999-"],
  mode: "full",
});

fileCase({
  name: "medium-markdown-diagnosis",
  category: "documentation",
  prompt: "Find the documented retry invariant.",
  text: `${"# Routine section\nNormal operational prose.\n".repeat(600)}\n## Retry invariant\nRETRY-INVARIANT: never retry after commit acknowledgement.\n`,
  question: "retry invariant acknowledgement",
  expected: ["RETRY-INVARIANT"],
});

for (const size of [128, 256, 512, 1024, 1536, 2048, 4096, 6144, 8192, 12288]) {
  const marker = `BOUNDARY-${size}-NEEDLE`;
  let boundary = "";
  let index = 0;
  while (boundary.length < size - marker.length - 2) {
    boundary += `distinct boundary row ${index} value ${((index * 2246822519) >>> 0).toString(36)}\n`;
    index += 1;
  }
  boundary = `${boundary.slice(0, size - marker.length - 1)}${marker}\n`;
  fileCase({
    name: `boundary-${size}-chars`,
    category: "threshold",
    prompt: `Find the marker in the ${size}-character boundary fixture.`,
    text: boundary,
    question: marker,
    expected: [marker],
  });
}

for (const size of [1537, 1540, 1560, 1600, 1700, 1800, 1900, 2048]) {
  const marker = `LOW-DENSITY-${size}-NEEDLE`;
  const phrase = "ordinary prose remains cheap to tokenize ";
  const repetitions = Math.ceil((size - marker.length - 1) / phrase.length);
  const text = `${phrase.repeat(repetitions).slice(0, size - marker.length - 1)}${marker}\n`;
  fileCase({
    name: `low-token-density-${size}-chars`,
    category: "adversarial-threshold",
    prompt: "Locate the exact marker without increasing context cost.",
    text,
    question: marker,
    expected: [marker],
  });
}

const jsonRows = Array.from({ length: 3500 }, (_, index) => ({
  id: index + 1,
  state: index === 2876 ? "STALE-LEASE-NEEDLE" : "ready",
  owner: `worker-${index % 17}`,
}));
fileCase({
  name: "large-json-query",
  category: "structured-text",
  prompt: "Locate the stale lease record.",
  text: JSON.stringify({ rows: jsonRows }, null, 2),
  question: "STALE-LEASE-NEEDLE",
  expected: ["STALE-LEASE-NEEDLE"],
});

fileCase({
  name: "large-build-log",
  category: "logs",
  prompt: "Find the decisive build failure.",
  text: Array.from(
    { length: 30000 },
    (_, index) => index === 24567
      ? "FATAL BUILD-NEEDLE linker rejected duplicate symbol"
      : `compile unit ${index + 1}: routine success`
  ).join("\n"),
  question: "FATAL BUILD-NEEDLE duplicate symbol",
  expected: ["FATAL BUILD-NEEDLE"],
});

fileCase({
  name: "two-distant-failures",
  category: "multi-evidence",
  prompt: "Report both distant failures and do not omit either.",
  text: Array.from(
    { length: 30000 },
    (_, index) => index === 5000
      ? "ERROR DISTANT-FIRST-NEEDLE cache poisoned"
      : index === 25000
        ? "FATAL DISTANT-SECOND-NEEDLE database unavailable"
        : `routine multi-evidence line ${index + 1}`
  ).join("\n"),
  question: "DISTANT-FIRST-NEEDLE DISTANT-SECOND-NEEDLE",
  expected: ["DISTANT-FIRST-NEEDLE", "DISTANT-SECOND-NEEDLE"],
});

fileCase({
  name: "three-distant-failures",
  category: "multi-evidence",
  prompt: "Report all three distant failures and do not omit any.",
  text: Array.from(
    { length: 30000 },
    (_, index) => index === 3000
      ? "ERROR EV-A first failure"
      : index === 15000
        ? "ERROR EV-B second failure"
        : index === 27000
          ? "ERROR EV-C third failure"
          : `routine three-evidence line ${index + 1}`
  ).join("\n"),
  question: "EV-A EV-B EV-C",
  expected: ["EV-A", "EV-B", "EV-C"],
});

fileCase({
  name: "three-distant-single-line-markers",
  category: "multi-evidence",
  prompt: "Report all three markers from the long single-line payload.",
  text: `${"a".repeat(12000)}ONE-A${"b".repeat(12000)}TWO-B${"c".repeat(12000)}THREE-C`,
  question: "ONE-A TWO-B THREE-C",
  expected: ["ONE-A", "TWO-B", "THREE-C"],
});

fileCase({
  name: "localized-large-source-edit",
  category: "editing",
  prompt: "Find the function that must be patched for the authorization bug.",
  text: Array.from(
    { length: 9000 },
    (_, index) => index === 7331
      ? "function AUTHORIZATION-PATCH-NEEDLE() { return unsafeGrant; }"
      : `function routine_${index}() { return ${index}; }`
  ).join("\n"),
  question: "AUTHORIZATION-PATCH-NEEDLE unsafeGrant",
  expected: ["AUTHORIZATION-PATCH-NEEDLE"],
});

fileCase({
  name: "minified-single-line-json",
  category: "structured-text",
  prompt: "Find the target in this minified response.",
  text: `{"padding":"${"x".repeat(180000)}","target":"MINIFIED-RIGHT-EDGE-NEEDLE"}`,
  question: "MINIFIED-RIGHT-EDGE-NEEDLE",
  expected: ["MINIFIED-RIGHT-EDGE-NEEDLE"],
});

let entropyState = 0x12345678;
let entropyText = "";
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
for (let index = 0; index < 180000; index += 1) {
  entropyState = (Math.imul(entropyState, 1664525) + 1013904223) >>> 0;
  entropyText += alphabet[entropyState & 63];
}
entropyText = `${entropyText.slice(0, 150000)}HIGH-ENTROPY-NEEDLE${entropyText.slice(150000)}`;
fileCase({
  name: "high-entropy-single-line",
  category: "high-entropy",
  prompt: "Locate the marker inside nonrepetitive single-line data.",
  text: entropyText,
  question: "HIGH-ENTROPY-NEEDLE",
  expected: ["HIGH-ENTROPY-NEEDLE"],
});

fileCase({
  name: "turkish-unicode-log",
  category: "unicode",
  prompt: "Türkçe hata kaydını bul.",
  text: Array.from(
    { length: 12000 },
    (_, index) => index === 10444
      ? "KRİTİK TÜRKÇE-İĞÜŞÖÇ-NEEDLE ödeme kilidi çözülemedi"
      : `olağan işlem satırı ${index + 1}`
  ).join("\n"),
  question: "TÜRKÇE-İĞÜŞÖÇ-NEEDLE ödeme kilidi",
  expected: ["TÜRKÇE-İĞÜŞÖÇ-NEEDLE"],
});

fileCase({
  name: "large-no-lexical-match",
  category: "low-confidence",
  prompt: "Determine whether an undocumented semantic anomaly exists.",
  text: Array.from(
    { length: 8000 },
    (_, index) => index === 6123
      ? "WARNING latent invariant drift detected"
      : `routine invariant observation ${index + 1}`
  ).join("\n"),
  question: "undocumented semantic anomaly",
  expected: ["WARNING latent invariant drift"],
});

const semanticDistractor = Array.from(
  { length: 7000 },
  (_, index) => index === 117
    ? "WARNING unrelated cache pressure"
    : index === 3300
      ? "permit_root_delete = true"
      : index === 6117
        ? "ERROR unrelated telemetry timeout"
        : `routine setting ${index}=off`
).join("\n");
fileCase({
  name: "semantic-distractor-safe-fallback",
  category: "adversarial-quality",
  prompt: "Which config enables privileged deletion?",
  text: semanticDistractor,
  question: "Which config enables privileged deletion?",
  expected: ["permit_root_delete = true"],
});

fileCase({
  name: "large-full-rewrite",
  category: "editing",
  prompt: "Rewrite every sentence while preserving all facts.",
  text: `${"Every sentence carries a distinct fact that must remain available.\n".repeat(5000)}`,
  question: "rewrite every sentence",
  expected: [],
  mode: "full",
});

const deltaFile = path.join(temporary, "repeated-delta.log");
const deltaOne = Array.from(
  { length: 16000 },
  (_, index) => index === 11000 ? "ERROR DELTA-FIRST-NEEDLE queue stalled" : `stable queue line ${index + 1}`
).join("\n");
fs.writeFileSync(deltaFile, deltaOne, "utf8");
const firstDelta = core.smartFile({
  path: deltaFile,
  question: "DELTA-FIRST-NEEDLE",
  max_chars: evidenceBudget,
});
const deltaTwoLines = deltaOne.split("\n");
deltaTwoLines[11001] = "FATAL DELTA-SECOND-NEEDLE queue corrupted";
const deltaTwo = deltaTwoLines.join("\n");
fs.writeFileSync(deltaFile, deltaTwo, "utf8");
const secondDelta = core.smartFile({
  path: deltaFile,
  question: "DELTA-SECOND-NEEDLE",
  max_chars: evidenceBudget,
});
const deltaDiff = core.diffCapsules({
  before_id: firstDelta.response.capsule_id,
  after_id: secondDelta.response.capsule_id,
  max_chars: evidenceBudget,
});
addCase({
  name: "repeated-delta-inspection",
  category: "session-delta",
  prompt: "The first capture is already known. Report only the new failure after the rerun.",
  baseline: deltaTwo,
  treatment: core.renderOperation(deltaDiff),
  route: "diff",
  invoked: true,
  expected: ["DELTA-SECOND-NEEDLE"],
});

const unchangedDelta = core.smartFile({
  path: deltaFile,
  question: "DELTA-SECOND-NEEDLE",
  max_chars: evidenceBudget,
});
const unchangedDiff = core.diffCapsules({
  before_id: secondDelta.response.capsule_id,
  after_id: unchangedDelta.response.capsule_id,
  max_chars: evidenceBudget,
});
addCase({
  name: "unchanged-rerun-confirmation",
  category: "session-delta",
  prompt: "Confirm whether the rerun changed anything.",
  baseline: deltaTwo,
  treatment: core.renderOperation(unchangedDiff),
  route: "diff-identical",
  invoked: true,
  expected: ['"identical":true'],
});

commandCase({
  name: "small-command",
  category: "command",
  prompt: "Check this known short status command.",
  args: ["-e", "console.log('STATUS-OK')"],
  question: "STATUS-OK",
  expected: ["STATUS-OK"],
});

commandCase({
  name: "large-test-command",
  category: "command",
  prompt: "Run the test emitter and locate the failure.",
  args: [
    "-e",
    "for(let i=0;i<18000;i++) console.log(i===15555?'FAIL TEST-COMMAND-NEEDLE expected 7 got 9':'PASS case '+i)",
  ],
  question: "FAIL TEST-COMMAND-NEEDLE",
  expected: ["TEST-COMMAND-NEEDLE"],
});

fileCase({
  name: "large-html-snapshot",
  category: "browser-snapshot",
  prompt: "Locate the inaccessible checkout button in the saved DOM snapshot.",
  text: Array.from(
    { length: 14000 },
    (_, index) => index === 12000
      ? '<button aria-disabled="true">CHECKOUT-DOM-NEEDLE</button>'
      : `<div data-row="${index}">routine node</div>`
  ).join("\n"),
  question: "CHECKOUT-DOM-NEEDLE aria-disabled",
  expected: ["CHECKOUT-DOM-NEEDLE"],
});

const skillText = fs.readFileSync(
  path.join(__dirname, "..", "optional-skills", "map-token-context", "SKILL.md"),
  "utf8"
);

process.stdout.write(JSON.stringify({
  tokenizer_model: "gpt-5",
  policy_threshold_chars: policyThreshold,
  evidence_budget_chars: evidenceBudget,
  activation_overhead: {
    tool_schema: JSON.stringify(schema),
    skill: "",
    optional_skill: skillText,
    server_instructions: schema.instructions,
  },
  cases,
}));

fs.rmSync(temporary, { recursive: true, force: true });
