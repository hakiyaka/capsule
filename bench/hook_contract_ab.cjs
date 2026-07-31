"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SEED = 549519342;
const PER_CLASS = 30;
const WORKER = "--worker";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function percent(before, after) {
  return before > 0 ? Number((((before - after) / before) * 100).toFixed(2)) : 0;
}

function randomGenerator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function token(random, length = 12) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += alphabet[Math.floor(random() * alphabet.length)];
  }
  return value;
}

function corpus() {
  const random = randomGenerator(SEED);
  const cases = [];
  for (let index = 0; index < PER_CLASS; index += 1) {
    const marker = token(random);
    cases.push({
      id: `contract-positive-${index}`,
      family: "hook_contract",
      eligible: true,
      raw: Array.from({ length: 520 }, (_, line) =>
        `build-step=${line}; status=ok; artifact=${marker}; unchanged dependency graph`
      ).join("\n"),
    });
    cases.push({
      id: `contract-negative-${index}`,
      family: "hook_contract",
      eligible: false,
      raw: `completed ${marker}; no additional output`,
    });

    const quiet = JSON.stringify({
      status: "running",
      activity: "no new output",
      worker: marker,
      detail: "worker remains active and no attention is required",
    });
    cases.push({
      id: `poll-positive-${index}`,
      family: "small_poll",
      eligible: true,
      raw: quiet,
    });
    cases.push({
      id: `poll-negative-${index}`,
      family: "small_poll",
      eligible: false,
      raw: JSON.stringify({
        status: "completed",
        worker: marker,
        final: `artifact ${marker} passed all checks`,
      }),
    });

    const records = [];
    for (let row = 0; row < 72; row += 1) {
      records.push(JSON.stringify({
        timestamp: `2026-07-28T${String(row % 24).padStart(2, "0")}:${String(row % 60).padStart(2, "0")}:00.000Z`,
        type: row % 3 === 0 ? "event_msg" : "response_item",
        payload: {
          type: row % 7 === 0 ? "function_call_output" : "message",
          text: `deployment ${marker} checkpoint ${row} ${token(random, 28)}`,
        },
      }));
    }
    cases.push({
      id: `session-positive-${index}`,
      family: "session_query",
      eligible: true,
      raw: records.join("\n"),
    });
    cases.push({
      id: `session-negative-${index}`,
      family: "session_query",
      eligible: false,
      raw: records.join("\n"),
    });
  }
  return cases;
}

function visibleResult(result, raw) {
  if (result?.continue === false && typeof result.reason === "string" && result.reason.trim()) {
    return [
      result.reason,
      result.hookSpecificOutput?.additionalContext || "",
    ].filter(Boolean).join("\n");
  }
  return String(raw);
}

function runWorker(arm) {
  Object.assign(process.env, {
    CAPSULE_REASONING_GOVERNOR: "0",
    CAPSULE_CONTROL_ENVELOPE: "0",
    CAPSULE_ABSOLUTE_OUTPUT: "0",
    CAPSULE_FAILURE_FUSE: "0",
    CAPSULE_MEDIA_REPLAY: "0",
    CAPSULE_ROUNDTRIP_TAX: "0",
    CAPSULE_SEQUENCE_FUSE: "0",
    CAPSULE_THREAD_PROJECTION: "0",
    CAPSULE_TRANSCRIPT_SHIELD: "1",
  });
  const hook = require("../scripts/hook.cjs");
  const core = require("../mcp/core.cjs");
  const rows = [];
  let oraclePasses = 0;

  for (const item of corpus()) {
    const session = `hook-contract-${arm}-${item.id}`;
    let result = {};
    if (item.family === "hook_contract") {
      process.env.CAPSULE_HOOK_WIRE = arm === "B" ? "1" : "0";
      process.env.CAPSULE_POLL_REPLAY = "0";
      process.env.CAPSULE_SESSION_QUERY = "0";
      result = hook.handle("posttooluse", {
        tool_name: "workspace.read_file",
        tool_input: { path: `fixtures/${item.id}.txt` },
        tool_response: item.raw,
        session_id: session,
        cwd: ROOT,
      });
    } else if (item.family === "small_poll") {
      process.env.CAPSULE_HOOK_WIRE = "1";
      process.env.CAPSULE_POLL_REPLAY = arm === "B" ? "1" : "0";
      process.env.CAPSULE_SESSION_QUERY = "0";
      const input = {
        tool_name: "wait_agent",
        tool_input: { target: item.id, timeout_ms: 60_000 },
        tool_response: item.raw,
        session_id: session,
        cwd: ROOT,
      };
      hook.handle("posttooluse", input);
      result = hook.handle("posttooluse", input);
    } else {
      process.env.CAPSULE_HOOK_WIRE = "1";
      process.env.CAPSULE_POLL_REPLAY = "0";
      process.env.CAPSULE_SESSION_QUERY = arm === "B" ? "1" : "0";
      const transcriptPath = item.eligible
        ? `C:\\Users\\fixture\\.codex\\sessions\\2026\\07\\${item.id}.jsonl`
        : `C:\\fixtures\\${item.id}.jsonl`;
      result = hook.handle("posttooluse", {
        tool_name: "workspace.read_file",
        tool_input: { path: transcriptPath, query: "deployment checkpoint" },
        tool_response: item.raw,
        session_id: session,
        cwd: ROOT,
      });
    }

    const visible = visibleResult(result, item.raw);
    let oracle = true;
    if (arm === "B" && item.eligible && item.family === "hook_contract") {
      oracle = result.continue === false &&
        typeof result.reason === "string" &&
        result.decision == null &&
        !/updatedMCPToolOutput|suppressOutput/.test(JSON.stringify(result));
    } else if (arm === "B" && item.eligible && item.family === "small_poll") {
      oracle = /\[Capsule poll: exactly unchanged\]/.test(visible);
    } else if (arm === "B" && item.eligible && item.family === "session_query") {
      const capsuleId = visible.match(/exact=(cap_[a-f0-9]{16})/i)?.[1];
      oracle = /session transcript projection/i.test(visible) &&
        Boolean(capsuleId) &&
        core.loadCapsule(capsuleId).text === item.raw;
    } else if (arm === "B" && !item.eligible && item.family === "session_query") {
      oracle = !/session transcript projection/i.test(visible);
    } else if (arm === "B" && !item.eligible && item.family === "small_poll") {
      oracle = visible === item.raw;
    } else if (arm === "B" && !item.eligible && item.family === "hook_contract") {
      oracle = visible === item.raw;
    }
    if (oracle) oraclePasses += 1;
    rows.push({
      id: item.id,
      family: item.family,
      eligible: item.eligible,
      oracle,
      visible,
      visible_chars: visible.length,
      raw_hash: sha256(item.raw),
      visible_hash: sha256(visible),
    });
  }
  process.stdout.write(JSON.stringify({
    arm,
    rows,
    oracle_passes: oraclePasses,
    oracle_total: rows.length,
  }));
}

function runArm(arm, temporaryRoot) {
  const state = path.join(temporaryRoot, arm.toLowerCase());
  fs.mkdirSync(state, { recursive: true });
  const child = spawnSync(process.execPath, [__filename, WORKER, arm], {
    cwd: ROOT,
    env: { ...process.env, CAPSULE_STATE: state },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`worker ${arm} failed: ${child.stderr || child.stdout}`);
  return JSON.parse(child.stdout);
}

function exactTokenBatch(texts) {
  const program = [
    "import importlib.metadata,json,sys,tiktoken",
    "payload=json.load(sys.stdin)",
    "enc=tiktoken.get_encoding('o200k_base')",
    "counts=[len(enc.encode(str(item))) for item in payload]",
    "print(json.dumps({'encoding':'o200k_base','version':importlib.metadata.version('tiktoken'),'counts':counts}))",
  ].join("\n");
  const child = spawnSync(process.env.PYTHON || "python", ["-c", program], {
    cwd: ROOT,
    input: JSON.stringify(texts),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  if (!child.error && child.status === 0) {
    const parsed = JSON.parse(child.stdout);
    return { exact: true, ...parsed };
  }
  return {
    exact: false,
    encoding: "chars/4-fallback",
    version: "",
    counts: texts.map((value) => Math.ceil(String(value).length / 4)),
    error: String(child.error?.message || child.stderr || `python exited ${child.status}`).slice(0, 500),
  };
}

function summarize(rows) {
  const baseline = rows.reduce((sum, row) => sum + row.baseline_tokens, 0);
  const treatment = rows.reduce((sum, row) => sum + row.treatment_tokens, 0);
  return {
    cases: rows.length,
    baseline_tokens: baseline,
    treatment_tokens: treatment,
    avoided_tokens: baseline - treatment,
    savings_percent: percent(baseline, treatment),
  };
}

function main() {
  if (process.argv[2] === WORKER) return runWorker(process.argv[3]);
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-hook-contract-ab-"));
  try {
    const baseline = runArm("A", temporaryRoot);
    const treatment = runArm("B", temporaryRoot);
    const texts = [...baseline.rows, ...treatment.rows].map((row) => row.visible);
    const tokenized = exactTokenBatch(texts);
    const half = baseline.rows.length;
    const rows = baseline.rows.map((row, index) => {
      const treated = treatment.rows[index];
      if (row.id !== treated.id || row.raw_hash !== treated.raw_hash) {
        throw new Error(`arm mismatch at ${index}`);
      }
      return {
        id: row.id,
        family: row.family,
        eligible: row.eligible,
        baseline_tokens: tokenized.counts[index],
        treatment_tokens: tokenized.counts[half + index],
        baseline_chars: row.visible_chars,
        treatment_chars: treated.visible_chars,
        oracle: treated.oracle,
      };
    });
    const families = {};
    for (const family of [...new Set(rows.map((row) => row.family))]) {
      const familyRows = rows.filter((row) => row.family === family);
      families[family] = {
        positive: summarize(familyRows.filter((row) => row.eligible)),
        mixed: summarize(familyRows),
        negative: summarize(familyRows.filter((row) => !row.eligible)),
        false_positive_count: familyRows.filter((row) =>
          !row.eligible && row.baseline_tokens !== row.treatment_tokens
        ).length,
      };
    }
    const manifest = corpus().map(({ id, family, eligible, raw }) => ({
      id, family, eligible, raw_sha256: sha256(raw),
    }));
    const report = {
      benchmark: "capsule-real-hook-contract",
      generated_at: new Date().toISOString(),
      seed: SEED,
      cases_per_class: PER_CLASS,
      corpus_manifest_sha256: sha256(JSON.stringify(manifest)),
      tokenizer: {
        exact: tokenized.exact,
        encoding: tokenized.encoding,
        version: tokenized.version,
        strings_counted: texts.length,
        ...(tokenized.error ? { fallback_reason: tokenized.error } : {}),
      },
      oracles: {
        baseline: `${baseline.oracle_passes}/${baseline.oracle_total}`,
        treatment: `${treatment.oracle_passes}/${treatment.oracle_total}`,
        all_treatment_pass: treatment.rows.every((row) => row.oracle),
      },
      overall_positive: summarize(rows.filter((row) => row.eligible)),
      overall_mixed: summarize(rows),
      families,
      caveat: "Exact model-visible payload A/B under current documented PostToolUse replacement semantics. It excludes fixed prompts, hidden reasoning, provider caching/billing, and host compaction envelopes.",
    };
    const writeIndex = process.argv.indexOf("--write");
    if (writeIndex >= 0) {
      const target = path.resolve(ROOT, process.argv[writeIndex + 1]);
      fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    process.stdout.write(`${JSON.stringify(report, null, process.argv.includes("--summary") ? 0 : 2)}\n`);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main();
