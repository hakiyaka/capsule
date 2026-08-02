"use strict";

const crypto = require("node:crypto");

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "do", "for", "from", "in", "into",
  "is", "it", "of", "on", "or", "that", "the", "this", "to", "with", "you", "your",
]);

const INTEGRATIONS = [
  ["firebase", /\bfirebase\b|firestore|firebase\.json|firestore\.rules/i],
  ["stripe", /\bstripe\b|paywall|checkout|subscription|webhook|price[_ -]?id/i],
  ["figma", /\bfigma\b|design(?: system| token)?|button(?:s)?|ui|ux/i],
  ["store", /\bapp ?store\b|play ?store|appstore|release notes|store listing/i],
  ["localization", /locali[sz]ation|i18n|l10n|translation|multilingual/i],
  ["media", /screenshot|screen shot|image|video|visual/i],
];

function terms(value) {
  return [...new Set(String(value || "")
    .toLocaleLowerCase("en-US")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}_-]+/gu, " ")
    .split(/\s+/)
    .map((item) => item.replace(/^[-_]+|[-_]+$/g, ""))
    .filter((item) => item.length >= 2 && !STOPWORDS.has(item)))]
    .slice(0, 96);
}

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function termHashes(value) {
  return terms(value).map(hash).slice(0, 32);
}

function overlap(left, right) {
  const a = new Set(Array.isArray(left) ? left : []);
  const b = new Set(Array.isArray(right) ? right : []);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const item of a) if (b.has(item)) common += 1;
  return common / new Set([...a, ...b]).size;
}

function integer(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
}

function detectIntegrations(prompt) {
  return INTEGRATIONS
    .filter(([, pattern]) => pattern.test(prompt))
    .map(([name]) => name);
}

function plan(args = {}) {
  const prompt = String(args.prompt || args.query || "").trim();
  if (!prompt) throw new Error("prompt is required for advisor plan");
  const enabled = process.env.CAPSULE_ADVISOR !== "0";
  const visible = process.env.CAPSULE_ADVISOR_VISIBLE !== "0";
  const currentTerms = termHashes(prompt);
  const previous = args.previous_task && typeof args.previous_task === "object"
    ? args.previous_task
    : {};
  const explicitBoundary = /\b(?:new|different|separate|unrelated)\s+(?:task|goal|request)\b/i.test(prompt);
  const similarity = overlap(currentTerms, previous.term_hashes);
  // Short acknowledgements and continuation commands are common after a
  // restart or a completed tool call. Keep them in the current task unless
  // the user explicitly declares a new/different goal; otherwise a harmless
  // "continue" would flush useful local evidence and replay context.
  const continuationCue = /^(?:continue|proceed|go\s+on|do\s+it|done|yes|okay|ok|restart(?:ed)?|run|fix|improve)\b[.!?\s]*$/i.test(prompt);
  const taskBoundary = Boolean(previous.fingerprint) && explicitBoundary ||
    Boolean(previous.fingerprint) && !continuationCue && similarity < 0.34;
  const integrations = detectIntegrations(prompt);
  const complex = prompt.length >= 480 || currentTerms.length >= 14 ||
    /\b(?:architecture|migration|production|security|incident|root cause|entire|all files)\b/i.test(prompt);
  const requested = integer(process.env.CAPSULE_TOOL_CALL_BUDGET, 0, 0, 96);
  const defaultBudget = complex ? 32 : integrations.length ? 24 + Math.min(8, integrations.length * 2) : 18;
  const maxToolCalls = requested || defaultBudget;
  const maxReadCalls = Math.max(6, Math.floor(maxToolCalls * 0.55));
  const maxOutputChars = complex ? 12_000 : 8_000;
  const explicitWorktree = /\b(?:worktree|git\s+branch|parallel\s+checkout)\b/i.test(prompt);
  const explicitAgents = /\b(?:subagent|delegate|parallel agent)\b/i.test(prompt);
  const emit = integrations.length > 0 || prompt.length >= 120 ||
    /\b(?:mcp|tool\s+calls?|many|all\s+files|batch|group|worktree|subagent|limit|quota|expensive|cost|paywall|locali[sz]ation|screenshot|screen|drag|drop|files?)\b/i.test(prompt);
  const workflow = [
    "route only the needed skill or integration",
    "batch independent reads and edits",
    "make one grouped mutation",
    "run one decisive verification",
    "stop when the acceptance condition is proven",
  ];
  const integrationPolicy = integrations.length
    ? integrations.map((name) => `${name}: one bounded lane; do not load its full catalog`).join(" | ")
    : "no external integration lane unless the task explicitly requires one";
  const context = enabled && visible ? `[Capsule advisor: calls<=${maxToolCalls}; reads<=${maxReadCalls}; ` +
    `batch=${integrations.length || "auto"}; task=${taskBoundary ? "new" : "same"}; ` +
    `worktree=${explicitWorktree ? "requested" : "off"}; agents=${explicitAgents ? "requested" : "off"}. ` +
    "Group edits, verify once, then stop. If Capsule is not visible after install, run doctor; " +
    "use capsule_force=true only for an indispensable read.]" : "";
  return {
    response: {
      operation: "plan",
      version: 1,
      advisor_enabled: enabled,
      activation: "UserPromptSubmit hook + capsule MCP; run doctor to verify installation",
      observability: "stats|gain|insight",
      escape_hatch: "capsule_force=true",
      task_id: hash(prompt),
      task_fingerprint: hash(prompt),
      term_hashes: currentTerms,
      task_boundary: taskBoundary,
      similarity: Number(similarity.toFixed(3)),
      complexity: complex ? "high" : "normal",
      integrations,
      max_tool_calls: maxToolCalls,
      max_read_calls: maxReadCalls,
      max_output_chars: maxOutputChars,
      max_parallel_calls: integrations.length ? 4 : 3,
      external_mcp_policy: integrationPolicy,
      subagents: explicitAgents ? "only if explicitly requested" : "off by default",
      worktree: explicitWorktree ? "explicit-request" : "off-by-default",
      workflow,
      context: emit && enabled && visible ? context : "",
      advisor_visible: emit && enabled && visible,
      privacy: "raw prompt text is not persisted; only a short fingerprint and term hashes are returned",
    },
    responseText: emit && enabled && visible ? context : "",
    route: "capsule-advisor",
  };
}

function dispatch(args = {}) {
  const operation = String(args.operation || "plan").toLowerCase();
  if (operation === "plan") return plan(args);
  throw new Error("advisor operation must be plan");
}

module.exports = { dispatch, overlap, plan, termHashes };
