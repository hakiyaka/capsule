"use strict";

const crypto = require("node:crypto");

const DETAIL_RE = /\b(?:verbatim|exhaustive|complete|full(?:\s+report)?|line[- ]by[- ]line|word[- ]for[- ]word|ayrıntılı|detaylı|eksiksiz|satır\s+satır|kelimesi\s+kelimesine|tam\s+metin)\b/i;
const DELTA_RE = /\b(?:status|current|active|again|same|confirm|verify|measure|how\s+much|why|restarted|şu\s+an|aktif|yeniden\s+başlattım|aynı|teyit|doğrula|ölç|ne\s+kadar|kaç|neden)\b/i;
const ACTION_RE = /\b(?:implement|build|fix|edit|change|install|research|compare|test|benchmark|yap|düzelt|geliştir|kur|araştır|karşılaştır|ölç)\b/i;

function promptText(input) {
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return "";
  for (const key of ["prompt", "query", "text", "user_prompt", "userPrompt", "message"]) {
    if (typeof input[key] === "string") return input[key];
  }
  try {
    return JSON.stringify(input).slice(0, 12000);
  } catch {
    return "";
  }
}

function compileQuotaShadow(input, escrow = {}) {
  const text = promptText(input).trim();
  if (text.length < 6) return { active: false, reason: "empty_or_tiny" };
  if (DETAIL_RE.test(text)) return { active: false, reason: "explicit_detail_preserved" };

  const action = ACTION_RE.test(text);
  const delta = !action && (DELTA_RE.test(text) || text.length <= 120);
  const mode = delta ? "semantic-delta" : "semantic-ir";
  const maxNewFacts = delta ? 4 : text.length > 1200 ? 10 : 7;
  const maxEvidence = delta ? 2 : 5;
  const allocated = Number(
    escrow.allocated_output_tokens
    || escrow.output_token_budget
    || (escrow.word_budget ? Math.ceil(Number(escrow.word_budget) * 1.5) : 0)
  );
  const shadowCap = allocated > 0
    ? Math.max(80, Math.min(allocated, delta ? 220 : 620))
    : (delta ? 220 : 620);
  const promptHash = crypto.createHash("sha256")
    .update(text.toLowerCase().replace(/\s+/g, " "))
    .digest("hex")
    .slice(0, 12);

  const context = "[Capsule answer v2: mode=" + mode
    + "; out<=" + shadowCap + "t; facts<=" + maxNewFacts + "; refs<=" + maxEvidence
    + "; final=outcome+delta+evidence+blocker; omit request/worklog/repeats;"
    + " zero-delta=1 sentence; detail/correctness override.]";

  return {
    active: true,
    version: 1,
    mode,
    prompt_hash: promptHash,
    shadow_output_cap: shadowCap,
    max_new_facts: maxNewFacts,
    max_evidence_refs: maxEvidence,
    context
  };
}

function mergeEscrowContext(escrow = {}, shadow = {}) {
  const fields = [
    `mode=${shadow.mode || "semantic-ir"}`,
    `out<=${Number(escrow.word_budget || 0)}w`,
    `tools<=${Number(escrow.tool_round_budget || 0)}`,
    `facts<=${Number(shadow.max_new_facts || 0)}`,
    `refs<=${Number(shadow.max_evidence_refs || 0)}`,
    `verify>=${Number(escrow.verification_reserve_percent || 0)}%`,
  ];
  return `[Capsule budget v2: ${fields.join("; ")}; batch safe reads; one branch; ` +
    "final=outcome+delta+evidence; omit request/worklog/repeats; detail/correctness override.]";
}

module.exports = {
  compileQuotaShadow,
  mergeEscrowContext,
  promptText
};
