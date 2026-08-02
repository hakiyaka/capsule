"use strict";

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("./core.cjs");
const compat = require("./compat.cjs");

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it",
  "of", "on", "or", "the", "then", "this", "to", "with",
]);
const ESCROW_ACTION_RE = /\b(add|analy[sz]e|audit|build|change|check|create|debug|design|develop|edit|fix|implement|improve|inspect|install|optimi[sz]e|refactor|research|review|test|verify)\b/iu;
const ESCROW_BRANCH_RE = /\b(all scenarios|alternatives?|compare|decision|every(?:thing|where)|hypotheses|options?|trade-?offs?)\b/iu;
const ESCROW_DETAIL_RE = /\b(exhaustive|full detail|in depth|long form|step by step|verbatim)\b/iu;
const ESCROW_TRIVIAL_RE = /^(?:hi|hello|hey|thanks|thank you|ok|okay)[.!?\s]*$/iu;
function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function certificate(input, extra = {}) {
  return {
    ...extra,
    input_sha256: sha256(JSON.stringify(stable(input))),
  };
}

function cognitionRoot() {
  const root = path.join(core.stateRoot(), "cognition");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function escrowLedgerFile() {
  return path.join(cognitionRoot(), "token-escrow.json");
}

function readEscrowLedger() {
  try {
    return JSON.parse(fs.readFileSync(escrowLedgerFile(), "utf8"));
  } catch {
    return {
      version: 1,
      turns_seen: 0,
      active_turns: 0,
      predicted_output_tokens_without_escrow: 0,
      allocated_output_tokens: 0,
      injected_context_tokens: 0,
      predicted_net_tokens_avoided: 0,
      by_mode: {},
      last: null,
    };
  }
}

function recordEscrowPlan(plan) {
  const ledger = readEscrowLedger();
  ledger.turns_seen = Number(ledger.turns_seen || 0) + 1;
  if (plan.active) {
    ledger.active_turns = Number(ledger.active_turns || 0) + 1;
    ledger.predicted_output_tokens_without_escrow =
      Number(ledger.predicted_output_tokens_without_escrow || 0) + plan.predicted_output_tokens_without_escrow;
    ledger.allocated_output_tokens =
      Number(ledger.allocated_output_tokens || 0) + plan.allocated_output_tokens;
    ledger.injected_context_tokens =
      Number(ledger.injected_context_tokens || 0) + plan.injected_context_tokens;
    ledger.predicted_net_tokens_avoided =
      Number(ledger.predicted_net_tokens_avoided || 0) + plan.predicted_net_tokens_avoided;
    const mode = ledger.by_mode[plan.pressure_mode] ||= { turns: 0, predicted_net_tokens_avoided: 0 };
    mode.turns += 1;
    mode.predicted_net_tokens_avoided += plan.predicted_net_tokens_avoided;
  }
  ledger.last = {
    at: new Date().toISOString(),
    active: plan.active,
    class: plan.class,
    pressure_mode: plan.pressure_mode,
    explicit_detail: plan.explicit_detail,
    allocated_output_tokens: plan.allocated_output_tokens,
    predicted_net_tokens_avoided: plan.predicted_net_tokens_avoided,
  };
  atomicWrite(escrowLedgerFile(), ledger);
}

function planEscrow(args = {}) {
  const prompt = String(args.prompt || "").trim();
  const pressureMode = ["normal", "high", "critical", "emergency"].includes(args.pressure_mode)
    ? args.pressure_mode
    : "normal";
  const disabled = process.env.CAPSULE_TOKEN_ESCROW === "0";
  const explicitDetail = ESCROW_DETAIL_RE.test(prompt);
  const action = ESCROW_ACTION_RE.test(prompt);
  const branchy = ESCROW_BRANCH_RE.test(prompt) || (prompt.match(/\b(?:and|or|ve|veya)\b/giu) || []).length >= 3;
  const question = /[?？]\s*$/.test(prompt);
  const trivial = !prompt || ESCROW_TRIVIAL_RE.test(prompt);
  const taskClass = explicitDetail ? "explicit-detail"
    : branchy ? "branching"
      : action ? "action"
        : question ? "question"
          : "simple";
  const predicted = {
    "explicit-detail": 2_000,
    branching: 1_200,
    action: 650,
    question: 360,
    simple: 180,
  }[taskClass];
  const baseWords = {
    "explicit-detail": 900,
    branching: 360,
    action: 220,
    question: 160,
    simple: 120,
  }[taskClass];
  const pressureScale = { normal: 1, high: 0.75, critical: 0.55, emergency: 0.35 }[pressureMode];
  const wordBudget = explicitDetail
    ? Math.max(700, Math.round(baseWords * Math.max(0.8, pressureScale)))
    : Math.max(90, Math.round(baseWords * pressureScale));
  const allocatedOutputTokens = Math.ceil(wordBudget * 1.33);
  const toolRounds = explicitDetail ? 8
    : pressureMode === "normal" ? (branchy ? 5 : 4)
      : pressureMode === "high" ? 3
        : 2;
  const reservePercent = pressureMode === "normal" ? 25 : pressureMode === "high" ? 30 : 35;
  const context = `[Capsule token escrow: final<=${wordBudget} words; tools<=${toolRounds} batched rounds; ` +
    `one live reasoning branch; compile finite choices; reserve ${reservePercent}% for verification; stop when verified. ` +
    "Explicit user detail and correctness override.]";
  const injectedContextTokens = core.approxTokens(context.length);
  const predictedNet = Math.max(0, predicted - allocatedOutputTokens - injectedContextTokens);
  const active = !disabled && !trivial &&
    (explicitDetail || action || branchy || question || prompt.length >= 120) &&
    predictedNet >= 32;
  const response = {
    active,
    class: taskClass,
    pressure_mode: pressureMode,
    explicit_detail: explicitDetail,
    word_budget: active ? wordBudget : 0,
    tool_round_budget: active ? toolRounds : 0,
    verification_reserve_percent: active ? reservePercent : 0,
    predicted_output_tokens_without_escrow: active ? predicted : 0,
    allocated_output_tokens: active ? allocatedOutputTokens : 0,
    injected_context_tokens: active ? injectedContextTokens : 0,
    predicted_net_tokens_avoided: active ? predictedNet : 0,
    context: active ? context : "",
    caveat: "Predictive pre-spend budget, not provider-billed savings; explicit detail and correctness override.",
  };
  if (args.record === true) recordEscrowPlan(response);
  return { response, capturedChars: prompt.length };
}

function escrowStatus() {
  return {
    response: {
      enabled: process.env.CAPSULE_TOKEN_ESCROW !== "0",
      ...readEscrowLedger(),
      caveat: "Predicted output-token avoidance from pre-spend budgets; not provider billing or end-to-end A/B proof.",
    },
    capturedChars: 0,
  };
}

function localSalt() {
  const file = path.join(cognitionRoot(), "salt");
  try {
    return fs.readFileSync(file);
  } catch {
    const salt = crypto.randomBytes(32);
    try {
      fs.writeFileSync(file, salt, { flag: "wx" });
      return salt;
    } catch {
      return fs.readFileSync(file);
    }
  }
}

function lexicalTokens(value) {
  return [...new Set(
    (String(value).toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_-]{2,}/gu) || [])
      .map((token) => token.replace(/^-+|-+$/g, ""))
      .filter((token) => token.length >= 2 && !STOP_WORDS.has(token))
  )].slice(0, 96);
}

function fingerprint(value) {
  const salt = localSalt();
  return lexicalTokens(value)
    .map((token) => crypto.createHmac("sha256", salt).update(token).digest("hex").slice(0, 20))
    .sort();
}

function projectDigest(project) {
  return crypto.createHmac("sha256", localSalt())
    .update(String(project || "default"))
    .digest("hex")
    .slice(0, 20);
}

function sanitize(value, limit = 900) {
  return compat.redact(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

class ArithmeticParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  skip() {
    while (/\s/.test(this.source[this.index] || "")) this.index += 1;
  }

  take(character) {
    this.skip();
    if (this.source[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  parse() {
    const value = this.expression();
    this.skip();
    if (this.index !== this.source.length || !Number.isFinite(value)) {
      throw new Error("invalid arithmetic expression");
    }
    return value;
  }

  expression() {
    let value = this.term();
    for (;;) {
      if (this.take("+")) value += this.term();
      else if (this.take("-")) value -= this.term();
      else return value;
    }
  }

  term() {
    let value = this.power();
    for (;;) {
      if (this.take("*")) value *= this.power();
      else if (this.take("/")) {
        const divisor = this.power();
        if (divisor === 0) throw new Error("division by zero");
        value /= divisor;
      } else if (this.take("%")) {
        const divisor = this.power();
        if (divisor === 0) throw new Error("division by zero");
        value %= divisor;
      } else return value;
    }
  }

  power() {
    let value = this.unary();
    if (this.take("^")) value **= this.power();
    return value;
  }

  unary() {
    if (this.take("+")) return this.unary();
    if (this.take("-")) return -this.unary();
    return this.primary();
  }

  primary() {
    if (this.take("(")) {
      const value = this.expression();
      if (!this.take(")")) throw new Error("missing closing parenthesis");
      return value;
    }
    this.skip();
    const match = this.source.slice(this.index).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if (!match) throw new Error("number expected");
    this.index += match[0].length;
    return Number(match[0]);
  }
}

function arithmeticFromPrompt(prompt) {
  const match = String(prompt).match(
    /(?:calculate|compute|evaluate)\s*:?\s*([0-9eE+\-*/%^().\s]+?)(?:[?.!]|$)/iu
  );
  if (!match) return null;
  const expression = match[1].trim();
  if (!expression || expression.length > 160 || /[eE]/.test(expression)) return null;
  try {
    const number = new ArithmeticParser(expression).parse();
    if (!Number.isFinite(number) || Math.abs(number) > 1e15) return null;
    const answer = Number.isInteger(number)
      ? String(number)
      : Number(number.toPrecision(12)).toString();
    return { expression, answer };
  } catch {
    return null;
  }
}

function inferredOperation(prompt) {
  const text = String(prompt).toLocaleLowerCase("en-US");
  const rules = [
    ["assign", /\b(assign|assignment|matching|allocate|allocation|personnel to tasks)\b/u],
    ["knapsack", /\b(knapsack|budget constraint|within budget|maximum value subset|portfolio selection)\b/u],
    ["path", /\b(shortest path|cheapest route|minimum cost path)\b/u],
    ["decision", /\b(compare|choose|select|option|alternative|criteria|trade-?off)\b/u],
    ["dag", /\b(dependenc|parallel|sequence|order|critical path|schedule)\b/u],
    ["cover", /\b(minimum set|fewest|cover all|all requirements)\b/u],
    ["hypotheses", /\b(diagnos|root cause|hypothes|next check|information gain)\b/u],
  ];
  return rules.find(([, pattern]) => pattern.test(text))?.[0] || "";
}

function jsonObjects(value) {
  const text = String(value);
  const objects = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === "\"") quoted = false;
        continue;
      }
      if (character === "\"") quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, index + 1));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) objects.push(parsed);
          } catch {
            // Continue searching; user prompts commonly contain non-JSON braces.
          }
          start = index;
          break;
        }
      }
    }
  }
  return objects;
}

function bytecodePacket(prompt) {
  const inferred = inferredOperation(prompt);
  for (const packet of jsonObjects(prompt)) {
    let operation = String(packet.operation || "").toLowerCase();
    if (operation === "decision") operation = "decide";
    if (operation === "assignment" || operation === "matching") operation = "assign";
    if (operation === "shortest-path" || operation === "shortest_path") operation = "path";
    if (!["cover", "dag", "decide", "hypotheses", "assign", "knapsack", "path"].includes(operation)) {
      operation = inferred === "decision" ? "decide" : inferred;
    }
    const shapeMatches =
      (operation === "cover" && Array.isArray(packet.requirements) && Array.isArray(packet.candidates)) ||
      (operation === "dag" && Array.isArray(packet.tasks)) ||
      (operation === "decide" && Array.isArray(packet.criteria) && Array.isArray(packet.options)) ||
      (operation === "hypotheses" && Array.isArray(packet.hypotheses) && Array.isArray(packet.checks)) ||
      (operation === "assign" && Array.isArray(packet.agents) && Array.isArray(packet.tasks)) ||
      (operation === "knapsack" && Array.isArray(packet.items) && packet.budget != null) ||
      (operation === "path" && Array.isArray(packet.edges) && packet.source != null && packet.target != null);
    if (shapeMatches) return { ...packet, operation };
  }
  return null;
}

function compactSolved(operation, result) {
  const proof = result.certificate || {};
  let answer;
  if (operation === "cover") {
    answer = {
      selected: result.selected,
      total_cost: result.total_cost,
      complete: proof.complete,
      missing: proof.missing,
    };
  } else if (operation === "dag") {
    answer = {
      batches: result.batches,
      critical_path: result.critical_path,
      critical_cost: result.critical_cost,
      acyclic: proof.acyclic,
    };
  } else if (operation === "decide") {
    answer = {
      winner: result.winner,
      ranking: result.ranking?.slice(0, 8),
      margin: result.margin,
      stable: result.stable,
    };
  } else if (operation === "assign") {
    answer = {
      assignments: result.assignments,
      total_cost: result.total_cost,
      complete: proof.complete,
    };
  } else if (operation === "knapsack") {
    answer = {
      selected: result.selected,
      total_cost: result.total_cost,
      total_value: result.total_value,
      budget: result.budget,
    };
  } else if (operation === "path") {
    answer = {
      path: result.path,
      total_cost: result.total_cost,
      reachable: proof.reachable,
    };
  } else {
    answer = {
      next_check: result.next_check,
      ranking: result.ranking?.slice(0, 8),
      prior_entropy: result.prior_entropy,
    };
  }
  const envelope = {
    solver: proof.solver,
    input_sha256: proof.input_sha256,
    result: answer,
  };
  return {
    answer,
    context: `[Capsule cognition certificate] ${JSON.stringify(envelope)} Do not recompute; reason only about facts absent from the packet.`
      .slice(0, 890),
  };
}

function compile(args = {}) {
  const prompt = String(args.prompt || args.problem || "").trim();
  if (!prompt) throw new Error("prompt is required");
  const arithmetic = arithmeticFromPrompt(prompt);
  if (arithmetic) {
    const digest = sha256(arithmetic.expression).slice(0, 10);
    return {
      response: {
        mode: "resolved",
        answer: arithmetic.answer,
        recommended_operation: "",
        context: `[Capsule cognition certificate arithmetic-v1:${digest}] result=${arithmetic.answer}; answer directly unless the expression changed.`,
        certificate: {
          solver: "arithmetic-v1",
          expression_sha256: sha256(arithmetic.expression),
          result: arithmetic.answer,
        },
      },
      capturedChars: prompt.length,
    };
  }
  const packet = bytecodePacket(prompt);
  if (packet) {
    try {
      const result = solve(packet).response;
      const compact = compactSolved(packet.operation, result);
      return {
        response: {
          mode: "resolved",
          answer: compact.answer,
          recommended_operation: packet.operation,
          context: compact.context,
          certificate: result.certificate,
        },
        capturedChars: prompt.length,
      };
    } catch {
      // Invalid or oversized packets fall through to advisory offload instead of blocking the turn.
    }
  }
  const terms = lexicalTokens(prompt);
  if (prompt.length < 12 || terms.length <= 2) {
    return {
      response: { mode: "bypass", recommended_operation: "", context: "", reason: "trivial" },
      capturedChars: prompt.length,
    };
  }
  const operation = inferredOperation(prompt);
  if (!operation) {
    return {
      response: { mode: "bounded", recommended_operation: "", context: "", reason: "no symbolic win predicted" },
      capturedChars: prompt.length,
    };
  }
  const context = `[Capsule cognition] Offload ${operation} search to capsule action=cognition operation=${operation}; use its certificate, then reason only about unencoded judgment.`;
  return {
    response: {
      mode: "offload",
      recommended_operation: operation,
      context,
      reason: "branching search has a deterministic solver",
    },
    capturedChars: prompt.length,
  };
}

function exactCover(args) {
  const requirements = [...new Set((args.requirements || []).map(String))].sort();
  const candidates = (args.candidates || []).map((candidate) => ({
    id: String(candidate.id || ""),
    covers: [...new Set((candidate.covers || []).map(String))],
    cost: Number(candidate.cost ?? 1),
  }));
  if (!requirements.length) throw new Error("requirements is required");
  if (!candidates.length || candidates.length > 20) throw new Error("candidates must contain 1..20 items");
  if (requirements.length > 64) throw new Error("requirements supports at most 64 items");
  if (candidates.some((item) => !item.id || !Number.isFinite(item.cost) || item.cost < 0)) {
    throw new Error("each candidate requires an id and a non-negative finite cost");
  }
  if (new Set(candidates.map((item) => item.id)).size !== candidates.length) {
    throw new Error("candidate ids must be unique");
  }
  const requirementSet = new Set(requirements);
  const possible = new Set(candidates.flatMap((item) => item.covers).filter((item) => requirementSet.has(item)));
  const impossible = requirements.filter((item) => !possible.has(item));
  const input = { requirements, candidates };
  if (impossible.length) {
    return {
      requirements,
      selected: [],
      total_cost: null,
      certificate: certificate(input, {
        solver: "exact-cover-v1",
        complete: false,
        missing: impossible,
        search_space: (2 ** candidates.length) - 1,
        examined: 0,
      }),
    };
  }
  let best = null;
  let examined = 0;
  const totalMasks = 2 ** candidates.length;
  for (let mask = 1; mask < totalMasks; mask += 1) {
    const selected = [];
    const covered = new Set();
    let cost = 0;
    for (let index = 0; index < candidates.length; index += 1) {
      if (!(mask & (2 ** index))) continue;
      const candidate = candidates[index];
      selected.push(candidate.id);
      cost += candidate.cost;
      if (best && cost > best.cost) break;
      for (const item of candidate.covers) {
        if (requirementSet.has(item)) covered.add(item);
      }
    }
    examined += 1;
    if (covered.size !== requirements.length) continue;
    selected.sort();
    const key = selected.join("\0");
    if (!best || cost < best.cost ||
        (cost === best.cost && selected.length < best.selected.length) ||
        (cost === best.cost && selected.length === best.selected.length && key < best.key)) {
      best = { cost, selected, key };
    }
  }
  return {
    requirements,
    selected: best.selected,
    total_cost: best.cost,
    certificate: certificate(input, {
      solver: "exact-cover-v1",
      complete: true,
      missing: [],
      search_space: totalMasks - 1,
      examined,
    }),
  };
}

function dag(args) {
  const tasks = (args.tasks || []).map((task) => ({
    id: String(task.id || ""),
    after: [...new Set((task.after || []).map(String))].sort(),
    cost: Number(task.cost ?? 1),
  }));
  if (!tasks.length || tasks.length > 128) throw new Error("tasks must contain 1..128 items");
  if (tasks.some((task) => !task.id || !Number.isFinite(task.cost) || task.cost < 0)) {
    throw new Error("each task requires an id and a non-negative finite cost");
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  if (byId.size !== tasks.length) throw new Error("task ids must be unique");
  for (const task of tasks) {
    for (const dependency of task.after) {
      if (!byId.has(dependency)) throw new Error(`unknown dependency: ${dependency}`);
    }
  }
  const indegree = new Map(tasks.map((task) => [task.id, task.after.length]));
  const outgoing = new Map(tasks.map((task) => [task.id, []]));
  for (const task of tasks) {
    for (const dependency of task.after) outgoing.get(dependency).push(task.id);
  }
  for (const value of outgoing.values()) value.sort();
  let ready = tasks.filter((task) => !task.after.length).map((task) => task.id).sort();
  const batches = [];
  const order = [];
  while (ready.length) {
    const batch = ready;
    batches.push(batch);
    ready = [];
    for (const id of batch) {
      order.push(id);
      for (const child of outgoing.get(id)) {
        indegree.set(child, indegree.get(child) - 1);
        if (indegree.get(child) === 0) ready.push(child);
      }
    }
    ready.sort();
  }
  const remaining = tasks.map((task) => task.id).filter((id) => !order.includes(id)).sort();
  const input = { tasks };
  if (remaining.length) {
    return {
      batches,
      critical_path: [],
      serial_cost: tasks.reduce((sum, task) => sum + task.cost, 0),
      critical_cost: null,
      certificate: certificate(input, {
        solver: "dag-v1",
        acyclic: false,
        cycle_nodes: remaining,
      }),
    };
  }
  const distance = new Map();
  const predecessor = new Map();
  for (const id of order) {
    const task = byId.get(id);
    let before = 0;
    let parent = "";
    for (const dependency of task.after) {
      const candidate = distance.get(dependency);
      if (candidate > before || (candidate === before && dependency < parent)) {
        before = candidate;
        parent = dependency;
      }
    }
    distance.set(id, before + task.cost);
    predecessor.set(id, parent);
  }
  const end = [...order].sort((left, right) =>
    distance.get(right) - distance.get(left) || left.localeCompare(right)
  )[0];
  const criticalPath = [];
  for (let cursor = end; cursor; cursor = predecessor.get(cursor)) criticalPath.unshift(cursor);
  return {
    batches,
    critical_path: criticalPath,
    serial_cost: tasks.reduce((sum, task) => sum + task.cost, 0),
    critical_cost: distance.get(end),
    certificate: certificate(input, {
      solver: "dag-v1",
      acyclic: true,
      cycle_nodes: [],
      tasks_scheduled: order.length,
    }),
  };
}

function decide(args) {
  const criteria = (args.criteria || []).map((criterion) => ({
    id: String(criterion.id || ""),
    weight: Number(criterion.weight ?? 1),
    direction: String(criterion.direction || "max").toLowerCase(),
  }));
  const options = (args.options || []).map((option) => ({
    id: String(option.id || ""),
    scores: option.scores || {},
  }));
  if (!criteria.length || criteria.length > 32) throw new Error("criteria must contain 1..32 items");
  if (!options.length || options.length > 64) throw new Error("options must contain 1..64 items");
  if (criteria.some((item) => !item.id || !Number.isFinite(item.weight) || item.weight <= 0 ||
      !["max", "min"].includes(item.direction))) {
    throw new Error("criteria require id, positive weight, and direction max|min");
  }
  if (new Set(criteria.map((item) => item.id)).size !== criteria.length ||
      new Set(options.map((item) => item.id)).size !== options.length) {
    throw new Error("criterion and option ids must be unique");
  }
  const ranges = new Map();
  for (const criterion of criteria) {
    const values = options.map((option) => Number(option.scores[criterion.id]));
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error(`all options require a numeric ${criterion.id} score`);
    }
    ranges.set(criterion.id, { min: Math.min(...values), max: Math.max(...values) });
  }
  const weightTotal = criteria.reduce((sum, item) => sum + item.weight, 0);
  const ranking = options.map((option) => {
    let total = 0;
    for (const criterion of criteria) {
      const value = Number(option.scores[criterion.id]);
      const range = ranges.get(criterion.id);
      const normalized = range.max === range.min
        ? 1
        : criterion.direction === "max"
          ? (value - range.min) / (range.max - range.min)
          : (range.max - value) / (range.max - range.min);
      total += normalized * criterion.weight;
    }
    return { id: option.id, score: Number((total / weightTotal).toFixed(6)) };
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const margin = ranking.length > 1 ? ranking[0].score - ranking[1].score : ranking[0].score;
  const input = { criteria, options };
  return {
    winner: ranking[0].id,
    ranking,
    margin: Number(margin.toFixed(6)),
    stable: margin > 0.05,
    certificate: certificate(input, {
      solver: "weighted-decision-v1",
      complete: true,
      normalized: true,
    }),
  };
}

function entropy(probabilities) {
  return probabilities.reduce((sum, probability) =>
    probability > 0 ? sum - probability * Math.log2(probability) : sum, 0);
}

function hypotheses(args) {
  const hypothesesInput = (args.hypotheses || []).map((item) => ({
    id: String(item.id || ""),
    prior: Number(item.prior ?? 1),
  }));
  const checks = (args.checks || []).map((item) => ({
    id: String(item.id || ""),
    cost: Number(item.cost ?? 1),
    positive: item.positive || {},
  }));
  if (hypothesesInput.length < 2 || hypothesesInput.length > 64) {
    throw new Error("hypotheses must contain 2..64 items");
  }
  if (!checks.length || checks.length > 64) throw new Error("checks must contain 1..64 items");
  if (hypothesesInput.some((item) => !item.id || !Number.isFinite(item.prior) || item.prior < 0) ||
      checks.some((item) => !item.id || !Number.isFinite(item.cost) || item.cost <= 0)) {
    throw new Error("hypotheses and checks require valid ids, priors, and costs");
  }
  const priorTotal = hypothesesInput.reduce((sum, item) => sum + item.prior, 0);
  if (priorTotal <= 0) throw new Error("hypothesis priors must have a positive total");
  const priors = hypothesesInput.map((item) => ({ id: item.id, prior: item.prior / priorTotal }));
  const baselineEntropy = entropy(priors.map((item) => item.prior));
  const ranking = checks.map((check) => {
    const likelihoods = priors.map((item) => {
      const value = Number(check.positive[item.id]);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        throw new Error(`check ${check.id} requires a 0..1 positive likelihood for ${item.id}`);
      }
      return value;
    });
    const positiveProbability = priors.reduce((sum, item, index) =>
      sum + item.prior * likelihoods[index], 0);
    const negativeProbability = 1 - positiveProbability;
    const positivePosterior = priors.map((item, index) =>
      positiveProbability > 0 ? item.prior * likelihoods[index] / positiveProbability : 0);
    const negativePosterior = priors.map((item, index) =>
      negativeProbability > 0 ? item.prior * (1 - likelihoods[index]) / negativeProbability : 0);
    const expectedEntropy =
      positiveProbability * entropy(positivePosterior) +
      negativeProbability * entropy(negativePosterior);
    const informationGain = Math.max(0, baselineEntropy - expectedEntropy);
    return {
      id: check.id,
      information_gain: Number(informationGain.toFixed(6)),
      information_gain_per_cost: Number((informationGain / check.cost).toFixed(6)),
      positive_probability: Number(positiveProbability.toFixed(6)),
    };
  }).sort((left, right) =>
    right.information_gain_per_cost - left.information_gain_per_cost ||
    right.information_gain - left.information_gain ||
    left.id.localeCompare(right.id)
  );
  const input = { hypotheses: hypothesesInput, checks };
  return {
    next_check: ranking[0].id,
    prior_entropy: Number(baselineEntropy.toFixed(6)),
    ranking,
    certificate: certificate(input, {
      solver: "information-gain-v1",
      normalized_priors: true,
    }),
  };
}

function normalizedIds(values, label) {
  const ids = (values || []).map((value) =>
    typeof value === "string" || typeof value === "number"
      ? String(value)
      : String(value?.id || "")
  ).sort();
  if (!ids.length || ids.some((id) => !id)) throw new Error(`${label} requires non-empty ids`);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} ids must be unique`);
  return ids;
}

function assign(args) {
  const agents = normalizedIds(args.agents, "agents");
  const tasks = normalizedIds(args.tasks, "tasks");
  if (agents.length > 16 || tasks.length > 16) throw new Error("assign supports at most 16 agents and tasks");
  const sourceAgents = new Map((args.agents || []).map((agent) => [
    String(typeof agent === "object" ? agent.id : agent),
    typeof agent === "object" ? agent : {},
  ]));
  const matrix = {};
  for (const agent of agents) {
    matrix[agent] = {};
    for (const task of tasks) {
      const value = Number(args.costs?.[agent]?.[task] ?? sourceAgents.get(agent)?.costs?.[task]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`assign requires a non-negative finite cost for ${agent}/${task}`);
      }
      matrix[agent][task] = value;
    }
  }
  const input = { agents, tasks, costs: matrix };
  if (agents.length < tasks.length) {
    return {
      assignments: [],
      total_cost: null,
      certificate: certificate(input, {
        solver: "exact-assignment-v1",
        complete: false,
        reason: "fewer agents than tasks",
        states_examined: 0,
      }),
    };
  }
  let states = new Map([[0, { cost: 0, assignments: [], key: "" }]]);
  let examined = 0;
  for (const task of tasks) {
    const next = new Map();
    for (const [mask, state] of states) {
      for (let index = 0; index < agents.length; index += 1) {
        const bit = 2 ** index;
        if ((mask & bit) !== 0) continue;
        examined += 1;
        const agent = agents[index];
        const item = { task, agent, cost: matrix[agent][task] };
        const assignments = [...state.assignments, item];
        const cost = state.cost + item.cost;
        const key = assignments.map((entry) => `${entry.task}\0${entry.agent}`).join("\0");
        const targetMask = mask | bit;
        const previous = next.get(targetMask);
        if (!previous || cost < previous.cost || (cost === previous.cost && key < previous.key)) {
          next.set(targetMask, { cost, assignments, key });
        }
      }
    }
    states = next;
  }
  const best = [...states.values()].sort((left, right) =>
    left.cost - right.cost || left.key.localeCompare(right.key)
  )[0];
  return {
    assignments: best.assignments,
    total_cost: best.cost,
    certificate: certificate(input, {
      solver: "exact-assignment-v1",
      complete: true,
      states_examined: examined,
    }),
  };
}

function knapsack(args) {
  const budget = Number(args.budget);
  const items = (args.items || []).map((item) => ({
    id: String(item.id || ""),
    cost: Number(item.cost ?? item.weight),
    value: Number(item.value),
  })).sort((left, right) => left.id.localeCompare(right.id));
  if (!Number.isInteger(budget) || budget < 0 || budget > 50_000) {
    throw new Error("knapsack budget must be an integer from 0..50000");
  }
  if (!items.length || items.length > 64) throw new Error("knapsack items must contain 1..64 items");
  if (items.some((item) => !item.id || !Number.isInteger(item.cost) || item.cost < 0 ||
      !Number.isFinite(item.value))) {
    throw new Error("knapsack items require id, non-negative integer cost, and finite value");
  }
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error("knapsack item ids must be unique");
  }
  let states = new Map([[0, { value: 0, selected: [], key: "" }]]);
  let examined = 0;
  for (const item of items) {
    const next = new Map(states);
    for (const [cost, state] of states) {
      const targetCost = cost + item.cost;
      if (targetCost > budget) continue;
      examined += 1;
      const selected = [...state.selected, item.id];
      const value = state.value + item.value;
      const key = selected.join("\0");
      const previous = next.get(targetCost);
      if (!previous || value > previous.value || (value === previous.value && key < previous.key)) {
        next.set(targetCost, { value, selected, key });
      }
    }
    states = next;
  }
  const best = [...states.entries()].map(([cost, state]) => ({ cost, ...state }))
    .sort((left, right) =>
      right.value - left.value || left.cost - right.cost ||
      left.selected.length - right.selected.length || left.key.localeCompare(right.key)
    )[0];
  const input = { budget, items };
  return {
    budget,
    selected: best.selected,
    total_cost: best.cost,
    total_value: best.value,
    certificate: certificate(input, {
      solver: "exact-knapsack-v1",
      complete: true,
      states_examined: examined,
    }),
  };
}

function shortestPath(args) {
  const source = String(args.source || "");
  const target = String(args.target || "");
  const directed = Boolean(args.directed);
  const edges = (args.edges || []).map((edge) => ({
    from: String(edge.from || ""),
    to: String(edge.to || ""),
    cost: Number(edge.cost ?? edge.weight ?? 1),
  }));
  if (!source || !target) throw new Error("path source and target are required");
  if (!edges.length || edges.length > 4096) throw new Error("path edges must contain 1..4096 items");
  if (edges.some((edge) => !edge.from || !edge.to || !Number.isFinite(edge.cost) || edge.cost < 0)) {
    throw new Error("path edges require from, to, and a non-negative finite cost");
  }
  const nodes = [...new Set([source, target, ...edges.flatMap((edge) => [edge.from, edge.to])])].sort();
  if (nodes.length > 512) throw new Error("path supports at most 512 nodes");
  const graph = new Map(nodes.map((node) => [node, []]));
  for (const edge of edges) {
    graph.get(edge.from).push({ node: edge.to, cost: edge.cost });
    if (!directed) graph.get(edge.to).push({ node: edge.from, cost: edge.cost });
  }
  for (const neighbors of graph.values()) {
    neighbors.sort((left, right) => left.node.localeCompare(right.node) || left.cost - right.cost);
  }
  const distance = new Map(nodes.map((node) => [node, Infinity]));
  const predecessor = new Map();
  const unsettled = new Set(nodes);
  const settled = [];
  distance.set(source, 0);
  while (unsettled.size) {
    const current = [...unsettled].sort((left, right) =>
      distance.get(left) - distance.get(right) || left.localeCompare(right)
    )[0];
    if (!Number.isFinite(distance.get(current))) break;
    unsettled.delete(current);
    settled.push(current);
    if (current === target) break;
    for (const edge of graph.get(current)) {
      if (!unsettled.has(edge.node)) continue;
      const candidate = distance.get(current) + edge.cost;
      const prior = predecessor.get(edge.node) || "\uffff";
      if (candidate < distance.get(edge.node) ||
          (candidate === distance.get(edge.node) && current < prior)) {
        distance.set(edge.node, candidate);
        predecessor.set(edge.node, current);
      }
    }
  }
  const reachable = Number.isFinite(distance.get(target));
  const route = [];
  if (reachable) {
    for (let cursor = target; cursor; cursor = predecessor.get(cursor)) {
      route.unshift(cursor);
      if (cursor === source) break;
    }
  }
  const input = { source, target, directed, edges };
  return {
    path: route,
    total_cost: reachable ? distance.get(target) : null,
    certificate: certificate(input, {
      solver: "dijkstra-v1",
      reachable,
      settled_nodes: settled.length,
    }),
  };
}

function solve(args = {}) {
  const operation = String(args.operation || "").toLowerCase();
  let response;
  if (operation === "cover") response = exactCover(args);
  else if (operation === "dag") response = dag(args);
  else if (operation === "decide" || operation === "decision") response = decide(args);
  else if (operation === "hypotheses") response = hypotheses(args);
  else if (operation === "assign" || operation === "assignment" || operation === "matching") response = assign(args);
  else if (operation === "knapsack") response = knapsack(args);
  else if (operation === "path" || operation === "shortest-path" || operation === "shortest_path") {
    response = shortestPath(args);
  } else {
    throw new Error("cognition solve operation must be cover, dag, decide, hypotheses, assign, knapsack, or path");
  }
  return { response, capturedChars: JSON.stringify(args).length };
}

function kernelDirectory() {
  const directory = path.join(cognitionRoot(), "kernels");
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function rememberFingerprint(args = {}) {
  const terms = [...new Set(args.terms || [])].sort();
  const solution = sanitize(args.solution);
  if (terms.length < 3) return { response: { stored: false, reason: "fingerprint too small" }, capturedChars: 0 };
  if (!solution) throw new Error("solution is required");
  const project = String(args.project_hash || projectDigest(args.project));
  const kernelId = `ck_${sha256(`${project}\0${terms.join("\0")}`).slice(0, 20)}`;
  const file = path.join(kernelDirectory(), `${kernelId}.json`);
  let previous = {};
  try {
    previous = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    previous = {};
  }
  atomicWrite(file, {
    kernel_id: kernelId,
    project_hash: project,
    terms,
    solution,
    created_at: previous.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    recalls: Number(previous.recalls || 0),
  });
  return {
    response: { stored: true, kernel_id: kernelId, fingerprint_terms: terms.length },
    capturedChars: String(args.solution || "").length,
  };
}

function remember(args = {}) {
  if (!args.prompt || typeof args.prompt !== "string") throw new Error("prompt is required");
  return rememberFingerprint({
    terms: fingerprint(args.prompt),
    project: args.project,
    solution: args.solution,
  });
}

function overlap(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  const score = intersection ? (2 * intersection) / (a.size + b.size) : 0;
  return { intersection, score };
}

function recallFingerprint(args = {}) {
  const terms = [...new Set(args.terms || [])].sort();
  const project = String(args.project_hash || projectDigest(args.project));
  if (terms.length < 3) return { response: { hit: false, reason: "fingerprint too small" }, capturedChars: 0 };
  const threshold = Math.max(0.5, Math.min(1, Number(args.threshold ?? 0.8)));
  let best = null;
  for (const name of fs.readdirSync(kernelDirectory()).filter((item) => item.endsWith(".json")).slice(-500)) {
    let kernel;
    try {
      kernel = JSON.parse(fs.readFileSync(path.join(kernelDirectory(), name), "utf8"));
    } catch {
      continue;
    }
    if (kernel.project_hash !== project) continue;
    const similarity = overlap(terms, kernel.terms || []);
    if (similarity.intersection < 3 || similarity.score < threshold) continue;
    if (!best || similarity.score > best.score ||
        (similarity.score === best.score && kernel.updated_at > best.kernel.updated_at)) {
      best = { kernel, score: similarity.score };
    }
  }
  if (!best) return { response: { hit: false, threshold }, capturedChars: 0 };
  const file = path.join(kernelDirectory(), `${best.kernel.kernel_id}.json`);
  best.kernel.recalls = Number(best.kernel.recalls || 0) + 1;
  best.kernel.last_recalled_at = new Date().toISOString();
  atomicWrite(file, best.kernel);
  return {
    response: {
      hit: true,
      kernel_id: best.kernel.kernel_id,
      score: Number(best.score.toFixed(6)),
      kernel: best.kernel.solution,
      stale_guard: "Reuse only when current state and evidence are unchanged.",
    },
    capturedChars: 0,
  };
}

function recall(args = {}) {
  if (!args.prompt || typeof args.prompt !== "string") throw new Error("prompt is required");
  return recallFingerprint({
    terms: fingerprint(args.prompt),
    project: args.project,
    threshold: args.threshold,
  });
}

const sessionFileCache = new Map();

function sessionsRoot() {
  return path.resolve(
    process.env.CAPSULE_SESSIONS_ROOT ||
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions")
  );
}

function locateSessionFile(args = {}) {
  const direct = String(
    args.session_file || args.sessionFile || args.transcript_path || args.transcriptPath || ""
  );
  if (direct && fs.existsSync(direct)) return path.resolve(direct);
  const session = String(args.session || "");
  const cached = sessionFileCache.get(session);
  if (cached && fs.existsSync(cached)) return cached;
  if (!/^[a-f0-9-]{20,}$/i.test(session)) return "";
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return "";
  const stack = [root];
  let examined = 0;
  while (stack.length && examined < 20_000) {
    const directory = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      examined += 1;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(target);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(session)) {
        sessionFileCache.set(session, target);
        return target;
      }
    }
  }
  return "";
}

function latestTokenUsage(file, maxBytes = 512 * 1024) {
  if (!file) return null;
  let descriptor;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    descriptor = fs.openSync(file, "r");
    fs.readSync(descriptor, buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
    const lines = text.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index].includes("\"token_count\"")) continue;
      let event;
      try {
        event = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      if (event?.type !== "event_msg" || event?.payload?.type !== "token_count") continue;
      const info = event.payload.info || {};
      const normalize = (usage = {}) => ({
        input_tokens: Number(usage.input_tokens || 0),
        cached_input_tokens: Number(usage.cached_input_tokens || 0),
        output_tokens: Number(usage.output_tokens || 0),
        reasoning_output_tokens: Number(usage.reasoning_output_tokens || 0),
        total_tokens: Number(usage.total_tokens || 0),
      });
      return {
        total: normalize(info.total_token_usage),
        last: normalize(info.last_token_usage),
        model_context_window: Number(info.model_context_window || 0),
      };
    }
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return null;
}

function governorFile(session) {
  const directory = path.join(cognitionRoot(), "governor");
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, `${sha256(session || "unknown").slice(0, 24)}.json`);
}

function governorThresholds(args = {}, previous = {}) {
  const configuredWarning = Number(
    args.warning ?? process.env.CAPSULE_REASONING_WARNING ?? previous.warning ?? 512
  );
  const warning = Number.isFinite(configuredWarning)
    ? Math.max(128, Math.trunc(configuredWarning))
    : 512;
  const configuredHard = Number(
    args.hard ?? process.env.CAPSULE_REASONING_BRAKE ?? previous.hard ?? warning * 3
  );
  const hard = Number.isFinite(configuredHard)
    ? Math.max(warning + 1, Math.trunc(configuredHard))
    : warning * 3;
  return { warning, hard };
}

function creditGovernorThresholds(args = {}, previous = {}) {
  const configuredWarning = Number(
    args.credit_warning ??
    process.env.CAPSULE_CREDIT_WARNING ??
    previous.credit_warning ??
    4_096
  );
  const warning = Number.isFinite(configuredWarning)
    ? Math.max(512, Math.trunc(configuredWarning))
    : 4_096;
  const configuredHard = Number(
    args.credit_hard ??
    process.env.CAPSULE_CREDIT_BRAKE ??
    previous.credit_hard ??
    warning * 3
  );
  const hard = Number.isFinite(configuredHard)
    ? Math.max(warning + 1, Math.trunc(configuredHard))
    : warning * 3;
  return { warning, hard };
}

function creditWeights(args = {}, previous = {}) {
  const output = Number(
    args.credit_output_multiplier ??
    process.env.CAPSULE_OUTPUT_MULTIPLIER ??
    previous.credit_output_multiplier ??
    6
  );
  const cached = Number(
    args.credit_cached_multiplier ??
    process.env.CAPSULE_CACHED_MULTIPLIER ??
    previous.credit_cached_multiplier ??
    0.1
  );
  return {
    output: Number.isFinite(output) ? Math.max(1, output) : 6,
    cached: Number.isFinite(cached) ? Math.min(1, Math.max(0, cached)) : 0.1,
  };
}

function creditWeightedUnits(usage = {}, weights = { output: 6, cached: 0.1 }) {
  const input = Math.max(0, Number(usage.input_tokens || 0));
  const cached = Math.min(input, Math.max(0, Number(usage.cached_input_tokens || 0)));
  const total = Math.max(0, Number(usage.total_tokens || 0));
  const reportedOutput = Math.max(0, Number(usage.output_tokens || 0));
  const reasoning = Math.max(0, Number(usage.reasoning_output_tokens || 0));
  const generated = total > input
    ? total - input
    : reportedOutput + reasoning;
  return Math.round(
    (input - cached) +
    cached * weights.cached +
    generated * weights.output
  );
}

function readGovernorState(session) {
  try {
    return JSON.parse(fs.readFileSync(governorFile(session), "utf8"));
  } catch {
    return null;
  }
}

function startGovernor(args = {}) {
  const session = String(args.session || "unknown");
  const file = locateSessionFile(args);
  const usage = latestTokenUsage(file);
  const thresholds = governorThresholds(args);
  const creditThresholds = creditGovernorThresholds(args);
  const weights = creditWeights(args);
  const state = {
    session_hash: sha256(session).slice(0, 24),
    session_file: file,
    baseline_reasoning: Number(usage?.total?.reasoning_output_tokens || 0),
    baseline_credit_units: creditWeightedUnits(usage?.total || {}, weights),
    emitted_level: 0,
    warning: thresholds.warning,
    hard: thresholds.hard,
    credit_warning: creditThresholds.warning,
    credit_hard: creditThresholds.hard,
    credit_output_multiplier: weights.output,
    credit_cached_multiplier: weights.cached,
    started_at: new Date().toISOString(),
  };
  atomicWrite(governorFile(session), state);
  return {
    response: {
      available: Boolean(usage),
      baseline_reasoning: state.baseline_reasoning,
      warning: state.warning,
      hard: state.hard,
      baseline_credit_units: state.baseline_credit_units,
      credit_warning: state.credit_warning,
      credit_hard: state.credit_hard,
      credit_output_multiplier: state.credit_output_multiplier,
      credit_cached_multiplier: state.credit_cached_multiplier,
      privacy: "token counters only; prompts and responses are not read",
    },
    capturedChars: 0,
  };
}

function checkGovernor(args = {}) {
  const session = String(args.session || "unknown");
  let state = readGovernorState(session);
  if (!state) {
    startGovernor(args);
    state = readGovernorState(session);
  }
  const file = locateSessionFile({ ...args, session_file: args.session_file || state?.session_file });
  const usage = latestTokenUsage(file);
  const thresholds = governorThresholds(args, state || {});
  const creditThresholds = creditGovernorThresholds(args, state || {});
  const weights = creditWeights(args, state || {});
  if (!usage) {
    return {
      response: {
        available: false,
        emit: false,
        level: "unavailable",
        context: "",
        privacy: "token counters only; prompts and responses are not read",
      },
      capturedChars: 0,
    };
  }
  let baseline = Number(state?.baseline_reasoning || 0);
  const current = Number(usage.total.reasoning_output_tokens || 0);
  if (current < baseline) baseline = current;
  const delta = Math.max(0, current - baseline);
  const currentCredit = creditWeightedUnits(usage.total, weights);
  let baselineCredit = Number(state?.baseline_credit_units);
  if (!Number.isFinite(baselineCredit) || currentCredit < baselineCredit) baselineCredit = currentCredit;
  const creditDelta = Math.max(0, currentCredit - baselineCredit);
  const reasoningLevel = delta >= thresholds.hard ? "brake" : delta >= thresholds.warning ? "warning" : "normal";
  const creditLevel = creditDelta >= creditThresholds.hard
    ? "brake"
    : creditDelta >= creditThresholds.warning
      ? "warning"
      : "normal";
  const level = reasoningLevel === "brake" || creditLevel === "brake"
    ? "brake"
    : reasoningLevel === "warning" || creditLevel === "warning"
      ? "warning"
      : "normal";
  const rank = level === "brake" ? 2 : level === "warning" ? 1 : 0;
  const emit = rank > Number(state?.emitted_level || 0);
  let context = "";
  if (emit && level === "warning") {
    context = `[Capsule governor: level=warn; r=${delta}; cw=${creditDelta}; ` +
      "reuse evidence; batch; no new branch/subagent; next decisive check.]";
  } else if (emit && level === "brake") {
    context = `[Capsule governor: level=brake; r=${delta}; cw=${creditDelta}; ` +
      "finish minimum verified path; no expansion unless correctness requires.]";
  }
  atomicWrite(governorFile(session), {
    ...state,
    session_file: file,
    baseline_reasoning: baseline,
    baseline_credit_units: baselineCredit,
    emitted_level: Math.max(Number(state?.emitted_level || 0), rank),
    warning: thresholds.warning,
    hard: thresholds.hard,
    credit_warning: creditThresholds.warning,
    credit_hard: creditThresholds.hard,
    credit_output_multiplier: weights.output,
    credit_cached_multiplier: weights.cached,
    checked_at: new Date().toISOString(),
  });
  return {
    response: {
      available: true,
      level,
      emit,
      context,
      reasoning_delta: delta,
      credit_weighted_delta: creditDelta,
      warning: thresholds.warning,
      hard: thresholds.hard,
      credit_warning: creditThresholds.warning,
      credit_hard: creditThresholds.hard,
      credit_output_multiplier: weights.output,
      credit_cached_multiplier: weights.cached,
      total: usage.total,
      last: usage.last,
      privacy: "token counters only; prompts and responses are not read",
    },
    capturedChars: 0,
  };
}

function governor(args = {}) {
  const mode = String(args.mode || "status").toLowerCase();
  if (mode === "start") return startGovernor(args);
  if (mode === "check") return checkGovernor(args);
  if (mode !== "status") throw new Error("governor mode must be start, check, or status");
  const session = String(args.session || "unknown");
  const state = readGovernorState(session);
  const file = locateSessionFile({ ...args, session_file: args.session_file || state?.session_file });
  const usage = latestTokenUsage(file);
  const baseline = Number(state?.baseline_reasoning || usage?.total?.reasoning_output_tokens || 0);
  const weights = creditWeights(args, state || {});
  const currentCredit = creditWeightedUnits(usage?.total || {}, weights);
  const baselineCredit = Number.isFinite(Number(state?.baseline_credit_units))
    ? Number(state.baseline_credit_units)
    : currentCredit;
  const creditDelta = Math.max(0, currentCredit - baselineCredit);
  const reasoningDelta = usage
    ? Math.max(0, Number(usage.total.reasoning_output_tokens || 0) - baseline)
    : 0;
  const statusLevel = state
    ? (
      reasoningDelta >= Number(state.hard) || creditDelta >= Number(state.credit_hard)
        ? "brake"
        : reasoningDelta >= Number(state.warning) || creditDelta >= Number(state.credit_warning)
          ? "warning"
          : "normal"
    )
    : "uninitialized";
  return {
    response: {
      available: Boolean(usage),
      level: statusLevel,
      reasoning_delta: usage ? reasoningDelta : null,
      credit_weighted_delta: usage ? creditDelta : null,
      total: usage?.total || null,
      last: usage?.last || null,
      warning: state?.warning ?? null,
      hard: state?.hard ?? null,
      credit_warning: state?.credit_warning ?? null,
      credit_hard: state?.credit_hard ?? null,
      credit_output_multiplier: weights.output,
      credit_cached_multiplier: weights.cached,
      started_at: state?.started_at ?? null,
      privacy: "token counters only; prompts and responses are not read",
    },
    capturedChars: 0,
  };
}

function turnFile(session) {
  const directory = path.join(cognitionRoot(), "turns");
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, `${sha256(session || "unknown").slice(0, 24)}.json`);
}

function notePrompt(args = {}) {
  startGovernor(args);
  const terms = fingerprint(args.prompt || "");
  if (terms.length < 3) return { stored: false };
  atomicWrite(turnFile(args.session), {
    terms,
    project_hash: projectDigest(args.project),
    at: new Date().toISOString(),
  });
  return { stored: true, terms: terms.length };
}

function commitSession(args = {}) {
  let turn;
  try {
    turn = JSON.parse(fs.readFileSync(turnFile(args.session), "utf8"));
  } catch {
    return { response: { stored: false, reason: "no prompt fingerprint" }, capturedChars: 0 };
  }
  return rememberFingerprint({
    terms: turn.terms,
    project_hash: turn.project_hash,
    solution: args.solution,
  });
}

function stats() {
  let kernels = 0;
  let recalls = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(kernelDirectory()).filter((item) => item.endsWith(".json"))) {
    try {
      const file = path.join(kernelDirectory(), name);
      const value = JSON.parse(fs.readFileSync(file, "utf8"));
      kernels += 1;
      recalls += Number(value.recalls || 0);
      bytes += fs.statSync(file).size;
    } catch {
      // Ignore a concurrently replaced or malformed optional kernel.
    }
  }
  return {
    response: {
      kernels,
      recalls,
      bytes,
      token_escrow: escrowStatus().response,
      prompt_storage: "HMAC token fingerprints only; raw prompts are not stored.",
    },
    capturedChars: 0,
  };
}

function delegateModel(prompt, requested) {
  if (requested) {
    if (!["gpt-5.6-luna", "gpt-5.6-terra"].includes(requested)) {
      throw new Error("delegate model must be gpt-5.6-luna or gpt-5.6-terra");
    }
    return requested;
  }
  const complex = String(prompt || "").length >= 1_200 ||
    /\b(?:architecture|migration|production|security|incident|forensic|root cause|distributed|concurren|race condition|data loss|threat model|cryptograph|legal|medical|financial|cross-platform|end-to-end)\b/i.test(String(prompt || ""));
  return complex ? "gpt-5.6-terra" : "gpt-5.6-luna";
}

function delegate(args = {}) {
  const prompt = String(args.prompt || "").trim();
  if (!prompt) throw new Error("prompt is required");
  const model = delegateModel(prompt, String(args.model || ""));
  const sandbox = ["read-only", "workspace-write"].includes(String(args.sandbox || ""))
    ? String(args.sandbox)
    : "read-only";
  const cwd = path.resolve(String(args.cwd || process.cwd()));
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error("cwd must be an existing directory");
  const timeoutMs = Math.min(900_000, Math.max(10_000, Number(args.timeout_ms || 180_000)));
  const maxChars = Math.min(24_000, Math.max(1_000, Number(args.max_chars || 8_000)));
  const workerPrompt = [
    "You are a bounded Capsule worker. Do not delegate or spawn other agents.",
    "Follow the task literally, return compact evidence, and do not perform writes unless the sandbox allows them.",
    prompt,
  ].join("\n\n");
  const command = process.platform === "win32" ? "codex.cmd" : "codex";
  const commandArgs = [
    "exec", "--model", model, "--sandbox", sandbox,
    "--skip-git-repo-check", "--color", "never",
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`delegate timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = stdout.trim();
      if (code !== 0) {
        reject(new Error(`delegate exited ${code}: ${stderr.trim().slice(-2_000)}`));
        return;
      }
      let capsuleId = null;
      let emitted = output;
      if (output.length > maxChars) {
        const saved = core.saveCapsule({
          kind: "delegated-agent-output",
          source: `codex://${model}`,
          text: output,
          question: prompt,
          maxChars,
          details: { model, sandbox, cwd },
        }).response;
        capsuleId = saved.capsule_id;
        emitted = `${output.slice(0, maxChars)}\n[exact:${capsuleId}]`;
      }
      resolve({
        response: {
          model,
          sandbox,
          cwd,
          output: emitted,
          capsule_id: capsuleId,
          exact_output_chars: output.length,
        },
        capturedChars: output.length,
      });
    });
    child.stdin.end(workerPrompt);
  });
}

function dispatch(args = {}) {
  const operation = String(args.operation || "compile").toLowerCase();
  if (operation === "compile") return compile(args);
  if ([
    "cover", "dag", "decide", "decision", "hypotheses",
    "assign", "assignment", "matching", "knapsack", "path", "shortest-path", "shortest_path",
  ].includes(operation)) return solve(args);
  if (operation === "governor") return governor(args);
  if (operation === "escrow") return String(args.mode || "plan").toLowerCase() === "status"
    ? escrowStatus()
    : planEscrow(args);
  if (operation === "remember") return remember(args);
  if (operation === "recall") return recall(args);
  if (operation === "delegate") return delegate(args);
  if (operation === "stats") return stats();
  throw new Error(
    "cognition operation must be compile, cover, dag, decide, hypotheses, assign, knapsack, path, " +
    "governor, escrow, remember, recall, delegate, or stats"
  );
}

const quotaShadowCompiler = require("./quota-shadow.cjs");

function planQuotaShadowEscrow(...args) {
  const base = planEscrow(...args);
  if (!base || typeof base !== "object") return base;
  const response = base.response && typeof base.response === "object" ? base.response : base;
  const contextKey = typeof response.context === "string"
    ? "context"
    : (typeof response.additionalContext === "string"
      ? "additionalContext"
      : (typeof response.additional_context === "string" ? "additional_context" : ""));
  if (!contextKey || !response[contextKey]) return base;
  const shadow = quotaShadowCompiler.compileQuotaShadow(args[0], response);
  if (!shadow.active) return base;
  const compactContext = quotaShadowCompiler.mergeEscrowContext(response, shadow);
  const injectedContextTokens = core.approxTokens(compactContext.length);
  const predictedNetTokensAvoided = Math.max(
    0,
    Number(response.predicted_output_tokens_without_escrow || 0)
      - Number(response.allocated_output_tokens || 0)
      - injectedContextTokens
  );
  const enriched = {
    ...response,
    [contextKey]: compactContext,
    injected_context_tokens: injectedContextTokens,
    predicted_net_tokens_avoided: predictedNetTokensAvoided,
    quota_shadow: {
      version: shadow.version,
      mode: shadow.mode,
      output_cap: shadow.shadow_output_cap,
      max_new_facts: shadow.max_new_facts,
      max_evidence_refs: shadow.max_evidence_refs,
    },
  };
  return response === base ? enriched : { ...base, response: enriched };
}

module.exports = {
  checkGovernor,
  commitSession,
  compile,
  delegate,
  dispatch,
  fingerprint,
  governor,
  locateSessionFile,
  notePrompt,
  planEscrow: planQuotaShadowEscrow,
  recall,
  recallFingerprint,
  remember,
  rememberFingerprint,
  solve,
  startGovernor,
  stats,
  escrowStatus,
};
