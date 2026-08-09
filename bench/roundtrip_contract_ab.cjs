"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SEED = 0x20c0ffee;
const ELIGIBLE_PER_FAMILY = 30;
const NEGATIVE_PER_FAMILY = 30;
const WORKER_FLAG = "--worker";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function percent(before, after) {
  return before > 0 ? Number(((before - after) / before * 100).toFixed(2)) : 0;
}

function rate(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator * 100).toFixed(2)) : 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function deterministicToken(random, length = 24) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += alphabet[Math.floor(random() * alphabet.length)];
  }
  return value;
}

function highEntropyText(length, salt) {
  const characters = new Array(length);
  let value = (SEED ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  if (value === 0) value = 0xa5a5a5a5;
  for (let index = 0; index < length; index += 1) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    characters[index] = String.fromCodePoint(0x4e00 + ((value >>> 0) % 20_000));
  }
  return characters.join("");
}

function visiblePostTool(result, raw) {
  const output = result?.hookSpecificOutput || {};
  const primary = output.updatedMCPToolOutput == null
    ? String(raw)
    : String(output.updatedMCPToolOutput);
  const additionalContext = String(output.additionalContext || "");
  return {
    primary,
    primary_hash: sha256(primary),
    additional_context_chars: additionalContext.length,
    visible_chars: primary.length + additionalContext.length,
    model_visible_parts: [primary, additionalContext].filter(Boolean),
    updated: output.updatedMCPToolOutput != null,
  };
}

function fixedTokenRecord({ input, cached, includeCached = true }) {
  const last = {
    input_tokens: input,
    output_tokens: 100,
    reasoning_output_tokens: 20,
    total_tokens: input + 100,
  };
  if (includeCached) last.cached_input_tokens = cached;
  return {
    timestamp: "2026-07-28T00:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        model_context_window: 120_000,
        last_token_usage: last,
        total_token_usage: {
          input_tokens: input,
          cached_input_tokens: 0,
          output_tokens: 100,
          reasoning_output_tokens: 20,
          total_tokens: input + 100,
        },
      },
    },
  };
}

function writePressureSession(file, options) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(fixedTokenRecord(options))}\n`, "utf8");
}

function workerEnvironment(arm) {
  const treatment = arm === "B";
  Object.assign(process.env, {
    CAPSULE_CONTROL_ENVELOPE: treatment ? "1" : "0",
    CAPSULE_ABSOLUTE_OUTPUT: treatment ? "1" : "0",
    CAPSULE_ABSOLUTE_OUTPUT_CHARS: "32000",
    CAPSULE_FORK_POLICY: treatment ? "auto" : "off",
    CAPSULE_SEQUENCE_FUSE: treatment ? "1" : "0",
    CAPSULE_ROUNDTRIP_TAX: treatment ? "1" : "0",
    CAPSULE_TEXT_DEDUPE: "0",
    CAPSULE_FAILURE_FUSE: "0",
    CAPSULE_MEDIA_DEDUPE: "0",
    CAPSULE_RECALL_LIMIT: "0",
    CAPSULE_COGNITION: "0",
    CAPSULE_REASONING_GOVERNOR: "0",
    CAPSULE_THREAD_PREFLIGHT: "0",
  });
}

function controlEnvelopeCorpus(hook, arm, random) {
  const rows = [];
  for (let index = 0; index < ELIGIBLE_PER_FAMILY; index += 1) {
    const body = [
      `fixture=${String(index).padStart(2, "0")}`,
      `value=${deterministicToken(random, 32)}`,
      "status=ok",
    ].join("\n");
    const raw = [
      "Exit code: 0",
      `Wall time: ${(0.1 + index / 100).toFixed(2)} seconds`,
      `Chunk ID: roundtrip-${String(index).padStart(2, "0")}`,
      `Original token count: ${body.length}`,
      index % 2 === 0 ? "Output:" : "Final Output:",
      body,
      "",
    ].join("\n");
    const result = hook.handle("posttooluse", {
      tool_name: "functions.shell_command",
      tool_input: { command: `Write-Output fixture-${index}` },
      tool_output: raw,
      session_id: `roundtrip-envelope-${arm}-${index}`,
      cwd: PROJECT_ROOT,
    });
    const visible = visiblePostTool(result, raw);
    rows.push({
      id: `control-envelope-positive-${index}`,
      eligible: true,
      raw_chars: raw.length,
      raw_hash: sha256(raw),
      semantic_hash: sha256(body),
      visible_chars: visible.visible_chars,
      primary_hash: visible.primary_hash,
      model_visible_parts: visible.model_visible_parts,
      transformed: visible.updated && visible.primary !== raw,
      recovery: visible.primary === body,
      payload_passthrough: visible.primary === raw,
      additional_context_chars: visible.additional_context_chars,
    });
  }

  for (let index = 0; index < NEGATIVE_PER_FAMILY; index += 1) {
    const kind = index % 3;
    let raw;
    let input;
    if (kind === 0) {
      raw = [
        "Exit code: 1",
        "Wall time: 0.2 seconds",
        "Output:",
        `ERROR fixture-${index} ${deterministicToken(random, 20)}`,
        "",
      ].join("\n");
      input = {
        tool_name: "functions.shell_command",
        tool_input: { command: "exit 1" },
        is_error: true,
      };
    } else if (kind === 1) {
      raw = `Script running with cell ID roundtrip-${index}`;
      input = {
        tool_name: "functions.shell_command",
        tool_input: { command: "npm test" },
      };
    } else {
      raw = `ordinary successful output ${index} ${deterministicToken(random, 36)}`;
      input = {
        tool_name: "functions.shell_command",
        tool_input: { command: `Write-Output ordinary-${index}` },
      };
    }
    const result = hook.handle("posttooluse", {
      ...input,
      tool_output: raw,
      session_id: `roundtrip-envelope-negative-${arm}-${index}`,
      cwd: PROJECT_ROOT,
    });
    const visible = visiblePostTool(result, raw);
    rows.push({
      id: `control-envelope-negative-${index}`,
      eligible: false,
      control: kind === 0 ? "failure" : kind === 1 ? "live-job" : "unframed-output",
      raw_chars: raw.length,
      raw_hash: sha256(raw),
      visible_chars: visible.visible_chars,
      primary_hash: visible.primary_hash,
      model_visible_parts: visible.model_visible_parts,
      transformed: visible.updated && visible.primary !== raw,
      recovery: visible.primary === raw,
      payload_passthrough: visible.primary === raw,
      additional_context_chars: visible.additional_context_chars,
    });
  }
  return rows;
}

function capsuleRecovery(core, primary, raw) {
  const capsuleId = String(primary).match(/exact=(cap_[a-f0-9]{16})/i)?.[1] || "";
  if (!capsuleId) {
    return {
      capsule_id: "",
      capsule_text_recovery: false,
      capsule_sha_recovery: false,
      header_sha_recovery: false,
    };
  }
  try {
    const capsule = core.loadCapsule(capsuleId);
    const expected = sha256(raw);
    const headerSha = String(primary).match(/sha256=([a-f0-9]{64})/i)?.[1] || "";
    return {
      capsule_id: capsuleId,
      capsule_text_recovery: capsule.text === raw,
      capsule_sha_recovery: capsule.metadata.sha256 === expected,
      header_sha_recovery: headerSha === expected,
    };
  } catch {
    return {
      capsule_id: capsuleId,
      capsule_text_recovery: false,
      capsule_sha_recovery: false,
      header_sha_recovery: false,
    };
  }
}

function absoluteOutputCorpus(hook, core, arm, fixtureRoot) {
  const rows = [];
  const normalFile = path.join(fixtureRoot, "normal-pressure.jsonl");
  writePressureSession(normalFile, { input: 20_000, cached: 19_000 });

  for (let index = 0; index < ELIGIBLE_PER_FAMILY; index += 1) {
    const raw = highEntropyText(48_000 + index * 17, index);
    const result = hook.handle("posttooluse", {
      tool_name: "workspace.read_file",
      tool_input: { path: `absolute-evidence-${index}.txt` },
      tool_output: raw,
      session_file: normalFile,
      session_id: `roundtrip-absolute-${arm}-${index}`,
      cwd: PROJECT_ROOT,
    });
    const visible = visiblePostTool(result, raw);
    const exact = capsuleRecovery(core, visible.primary, raw);
    rows.push({
      id: `absolute-output-positive-${index}`,
      eligible: true,
      raw_chars: raw.length,
      raw_hash: sha256(raw),
      visible_chars: visible.visible_chars,
      primary_hash: visible.primary_hash,
      model_visible_parts: visible.model_visible_parts,
      transformed: visible.updated && visible.primary !== raw,
      absolute_cap: /pressure circuit:\s*absolute-cap/i.test(visible.primary),
      recovery: exact.capsule_text_recovery &&
        exact.capsule_sha_recovery &&
        exact.header_sha_recovery,
      payload_passthrough: visible.primary === raw,
      additional_context_chars: visible.additional_context_chars,
      ...exact,
    });
  }

  for (let index = 0; index < NEGATIVE_PER_FAMILY; index += 1) {
    const kind = index % 3;
    const belowThreshold = kind === 0;
    const raw = highEntropyText(belowThreshold ? 24_000 + index : 40_000 + index, 10_000 + index);
    const input = {
      tool_name: kind === 1 ? "workspace.write_file" : "workspace.read_file",
      tool_input: kind === 1
        ? { path: `mutating-${index}.txt`, content: "fixture" }
        : { path: `negative-${index}.txt` },
      tool_output: raw,
      session_file: normalFile,
      session_id: `roundtrip-absolute-negative-${arm}-${index}`,
      cwd: PROJECT_ROOT,
      ...(kind === 2 ? { is_error: true } : {}),
    };
    const result = hook.handle("posttooluse", input);
    const visible = visiblePostTool(result, raw);
    rows.push({
      id: `absolute-output-negative-${index}`,
      eligible: false,
      control: kind === 0 ? "below-threshold" : kind === 1 ? "mutating-tool" : "failed-result",
      raw_chars: raw.length,
      raw_hash: sha256(raw),
      visible_chars: visible.visible_chars,
      primary_hash: visible.primary_hash,
      model_visible_parts: visible.model_visible_parts,
      transformed: visible.updated && visible.primary !== raw,
      absolute_cap: /pressure circuit:\s*absolute-cap/i.test(visible.primary),
      recovery: visible.primary === raw,
      payload_passthrough: visible.primary === raw,
      additional_context_chars: visible.additional_context_chars,
    });
  }
  return rows;
}

function historyFixture(index, random) {
  const turns = 20 + (index % 21);
  return Array.from({ length: turns }, (_, turn) =>
    `turn-${String(turn + 1).padStart(2, "0")}:${deterministicToken(random, 40)}:` +
    "historical parent context ".repeat(8)
  );
}

function forkExposure(result, toolInput, history) {
  const output = result?.hookSpecificOutput || {};
  const effective = output.updatedInput || toolInput;
  const forkTurns = effective.fork_turns ?? effective.forkTurns ?? "all";
  const retained = forkTurns === "none"
    ? []
    : typeof forkTurns === "string" && /^\d+$/.test(forkTurns)
    ? history.slice(-Number(forkTurns))
    : history;
  const message = String(effective.message || effective.prompt || effective.task || "");
  const childChars = message.length + retained.join("\n").length;
  const guidanceChars = String(output.additionalContext || "").length;
  return {
    visible_chars: childChars + guidanceChars,
    child_chars: childChars,
    guidance_chars: guidanceChars,
    model_visible_parts: [message, retained.join("\n"), String(output.additionalContext || "")]
      .filter(Boolean),
    fork_turns: String(forkTurns),
    message_hash: sha256(message),
    updated: Boolean(output.updatedInput),
  };
}

function subagentForkCorpus(hook, arm, random) {
  const rows = [];
  for (let index = 0; index < ELIGIBLE_PER_FAMILY; index += 1) {
    const history = historyFixture(index, random);
    const message = `Independently inspect C:\\fixtures\\artifact-${index}.json for duplicate identifiers, ` +
      "invalid timestamps, and missing required fields. Return a compact JSON report with counts, affected " +
      "identifiers, and the exact validation rule for each finding. Do not modify files or use the network. " +
      `This message contains the complete task, inputs, constraints, and output format. seed=${SEED}.`;
    const toolInput = {
      task_name: `roundtrip_fork_${index}`,
      message,
      fork_turns: "all",
    };
    const result = hook.handle("pretooluse", {
      tool_name: "collaboration.spawn_agent",
      tool_input: toolInput,
      session_id: `roundtrip-fork-${arm}-${index}`,
      cwd: PROJECT_ROOT,
    });
    const exposure = forkExposure(result, toolInput, history);
    rows.push({
      id: `subagent-fork-positive-${index}`,
      eligible: true,
      history_turns: history.length,
      original_fork_turns: "all",
      selected_fork_turns: exposure.fork_turns,
      visible_chars: exposure.visible_chars,
      child_chars: exposure.child_chars,
      model_visible_parts: exposure.model_visible_parts,
      additional_context_chars: exposure.guidance_chars,
      primary_hash: sha256(`${exposure.fork_turns}\0${exposure.message_hash}`),
      transformed: exposure.fork_turns !== "all",
      recovery: exposure.message_hash === sha256(message),
      payload_passthrough: exposure.fork_turns === "all",
    });
  }

  for (let index = 0; index < NEGATIVE_PER_FAMILY; index += 1) {
    const history = historyFixture(100 + index, random);
    const dependent = index < NEGATIVE_PER_FAMILY / 2;
    const message = dependent
      ? `Continue the analysis from our earlier discussion and use every decision above for fixture ${index}.`
      : `Run npm test for fixture ${index} and report only the failing test names.`;
    const originalFork = dependent ? "all" : index % 2 === 0 ? "none" : "3";
    const toolInput = {
      task_name: `roundtrip_fork_negative_${index}`,
      message,
      fork_turns: originalFork,
    };
    const result = hook.handle("pretooluse", {
      tool_name: "collaboration.spawn_agent",
      tool_input: toolInput,
      session_id: `roundtrip-fork-negative-${arm}-${index}`,
      cwd: PROJECT_ROOT,
    });
    const exposure = forkExposure(result, toolInput, history);
    rows.push({
      id: `subagent-fork-negative-${index}`,
      eligible: false,
      control: dependent ? "history-dependent-full" : "already-bounded",
      history_turns: history.length,
      original_fork_turns: originalFork,
      selected_fork_turns: exposure.fork_turns,
      visible_chars: exposure.visible_chars,
      child_chars: exposure.child_chars,
      model_visible_parts: exposure.model_visible_parts,
      additional_context_chars: exposure.guidance_chars,
      primary_hash: sha256(`${exposure.fork_turns}\0${exposure.message_hash}`),
      transformed: exposure.fork_turns !== originalFork,
      recovery: exposure.message_hash === sha256(message),
      payload_passthrough: exposure.fork_turns === originalFork,
    });
  }
  return rows;
}

function guidanceText(result) {
  return String(result?.hookSpecificOutput?.additionalContext || "");
}

function sequenceFuseCorpus(hook, arm) {
  const positives = [];
  const negatives = [];
  const read = (session, target) => hook.handle("pretooluse", {
    tool_name: "workspace.read_file",
    tool_input: { path: target },
    session_id: session,
    cwd: PROJECT_ROOT,
  });

  for (let index = 0; index < 30; index += 1) {
    const session = `roundtrip-sequence-positive-${arm}-${index}`;
    let result = {};
    for (const target of ["alpha.txt", "beta.txt", "gamma.txt", "alpha.txt", "beta.txt", "gamma.txt"]) {
      result = read(session, `${index}-${target}`);
    }
    positives.push({
      id: `sequence-positive-${index}`,
      detected: /sequence fuse/i.test(guidanceText(result)),
    });
  }

  for (let index = 0; index < 30; index += 1) {
    const session = `roundtrip-sequence-negative-${arm}-${index}`;
    let result = {};
    if (index % 2 === 0) {
      for (const target of ["alpha.txt", "beta.txt", "gamma.txt", "alpha.txt", "beta.txt", "delta.txt"]) {
        result = read(session, `${index}-${target}`);
      }
    } else {
      for (const target of ["alpha.txt", "beta.txt", "gamma.txt"]) {
        read(session, `${index}-${target}`);
      }
      hook.handle("posttooluse", {
        tool_name: "apply_patch",
        tool_input: { patch: "*** Begin Patch\n*** End Patch" },
        tool_output: "Done!",
        session_id: session,
        cwd: PROJECT_ROOT,
      });
      for (const target of ["alpha.txt", "beta.txt", "gamma.txt"]) {
        result = read(session, `${index}-${target}`);
      }
    }
    negatives.push({
      id: `sequence-negative-${index}`,
      detected: /sequence fuse/i.test(guidanceText(result)),
      control: index % 2 === 0 ? "changed-sequence" : "mutation-reset",
    });
  }
  return { positives, negatives };
}

function roundTripTaxCorpus(hook, arm, fixtureRoot) {
  const positives = [];
  const negatives = [];

  for (let index = 0; index < 30; index += 1) {
    const file = path.join(fixtureRoot, `tax-positive-${index}.jsonl`);
    const inputTokens = 80_000 + index * 100;
    const cachedTokens = 54_000 + index * 25;
    writePressureSession(file, { input: inputTokens, cached: cachedTokens });
    const input = {
      prompt: `Implement the next concrete change for fixture ${index}.`,
      session_file: file,
      session_id: `roundtrip-tax-positive-${arm}-${index}`,
      cwd: PROJECT_ROOT,
    };
    const first = hook.handle("userpromptsubmit", input);
    const repeated = hook.handle("userpromptsubmit", input);
    writePressureSession(file, { input: inputTokens + 1_000, cached: cachedTokens });
    const changed = hook.handle("userpromptsubmit", input);
    positives.push({
      id: `roundtrip-tax-positive-${index}`,
      detected: /round-trip tax/i.test(guidanceText(first)),
      duplicate_suppressed: !/round-trip tax/i.test(guidanceText(repeated)),
      changed_sample_detected: /round-trip tax/i.test(guidanceText(changed)),
    });
  }

  for (let index = 0; index < 30; index += 1) {
    const file = path.join(fixtureRoot, `tax-negative-${index}.jsonl`);
    const missingTelemetry = index >= 15;
    writePressureSession(file, missingTelemetry
      ? { input: 80_000, cached: 0, includeCached: false }
      : { input: 80_000, cached: 77_000, includeCached: true });
    const result = hook.handle("userpromptsubmit", {
      prompt: `Inspect healthy cache fixture ${index}.`,
      session_file: file,
      session_id: `roundtrip-tax-negative-${arm}-${index}`,
      cwd: PROJECT_ROOT,
    });
    negatives.push({
      id: `roundtrip-tax-negative-${index}`,
      detected: /round-trip tax/i.test(guidanceText(result)),
      control: missingTelemetry ? "telemetry-unavailable" : "healthy-cache",
    });
  }
  return { positives, negatives };
}

function runWorker(arm) {
  if (!["A", "B"].includes(arm)) throw new Error(`Invalid worker arm: ${arm}`);
  if (!process.env.CAPSULE_STATE) {
    throw new Error("CAPSULE_STATE is required for a worker");
  }
  workerEnvironment(arm);
  const random = mulberry32(SEED);
  const core = require("../mcp/core.cjs");
  const hook = require("../scripts/hook.cjs");
  const unified = require("../mcp/unified.cjs");
  const fixtureRoot = path.join(process.env.CAPSULE_STATE, "fixtures");
  try {
    return {
      arm,
      toggles: {
        control_envelope: process.env.CAPSULE_CONTROL_ENVELOPE,
        absolute_output: process.env.CAPSULE_ABSOLUTE_OUTPUT,
        fork_policy: process.env.CAPSULE_FORK_POLICY,
        sequence_fuse: process.env.CAPSULE_SEQUENCE_FUSE,
        roundtrip_tax: process.env.CAPSULE_ROUNDTRIP_TAX,
      },
      direct: {
        control_envelope: controlEnvelopeCorpus(hook, arm, random),
        absolute_output: absoluteOutputCorpus(hook, core, arm, fixtureRoot),
        subagent_fork: subagentForkCorpus(hook, arm, random),
      },
      detection_only: {
        sequence_fuse: sequenceFuseCorpus(hook, arm),
        roundtrip_cache_tax: roundTripTaxCorpus(hook, arm, fixtureRoot),
      },
    };
  } finally {
    unified.closeSearchDatabase();
  }
}

function runArm(arm, temporaryRoot) {
  const state = path.join(temporaryRoot, arm.toLowerCase());
  fs.mkdirSync(state, { recursive: true });
  const child = spawnSync(process.execPath, [__filename, WORKER_FLAG, arm], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      CAPSULE_STATE: state,
    },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`Worker ${arm} failed with status ${child.status}: ${child.stderr || child.stdout}`);
  }
  try {
    return JSON.parse(child.stdout);
  } catch (error) {
    throw new Error(`Worker ${arm} returned invalid JSON: ${error.message}\n${child.stdout.slice(0, 2_000)}`);
  }
}

function exactTokenBatch(texts) {
  const program = [
    "import importlib.metadata",
    "import json",
    "import sys",
    "import tiktoken",
    "payload = json.load(sys.stdin)",
    "encoding = tiktoken.get_encoding('o200k_base')",
    "counts = [len(encoding.encode(str(item))) for item in payload]",
    "print(json.dumps({'encoding': 'o200k_base', 'version': importlib.metadata.version('tiktoken'), 'counts': counts}))",
  ].join("\n");
  const child = spawnSync(process.env.PYTHON || "python", ["-c", program], {
    cwd: PROJECT_ROOT,
    input: JSON.stringify(texts),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  if (!child.error && child.status === 0) {
    try {
      const parsed = JSON.parse(child.stdout);
      if (Array.isArray(parsed.counts) &&
          parsed.counts.length === texts.length &&
          parsed.counts.every((value) => Number.isInteger(value) && value >= 0)) {
        return {
          exact: true,
          encoding: parsed.encoding,
          version: parsed.version,
          counts: parsed.counts,
          invocation_count: 1,
        };
      }
    } catch {
      // Fall through to the explicit approximation below.
    }
  }
  return {
    exact: false,
    encoding: "chars/4-fallback",
    version: "",
    counts: texts.map((text) => Math.ceil(String(text).length / 4)),
    invocation_count: 1,
    error: String(child.error?.message || child.stderr || `python exited ${child.status}`).slice(0, 500),
  };
}

function attachTokenAccounting(baseline, treatment) {
  const rows = [];
  const texts = [];
  for (const arm of [baseline, treatment]) {
    for (const family of Object.values(arm.direct)) {
      for (const row of family) {
        const parts = Array.isArray(row.model_visible_parts) ? row.model_visible_parts : [];
        const start = texts.length;
        texts.push(...parts.map(String));
        rows.push({ row, start, end: texts.length });
      }
    }
  }
  const tokenized = exactTokenBatch(texts);
  for (const item of rows) {
    item.row.model_visible_tokens = tokenized.counts
      .slice(item.start, item.end)
      .reduce((total, value) => total + value, 0);
    item.row.tokenizer_exact = tokenized.exact;
    delete item.row.model_visible_parts;
  }
  return {
    exact: tokenized.exact,
    encoding: tokenized.encoding,
    version: tokenized.version,
    invocation_count: tokenized.invocation_count,
    strings_counted: texts.length,
    ...(tokenized.error ? { fallback_reason: tokenized.error } : {}),
  };
}

function summarizeExposure(rows) {
  const baseline = rows.reduce((total, row) => total + row.baseline_chars, 0);
  const treatment = rows.reduce((total, row) => total + row.treatment_chars, 0);
  const baselineTokens = rows.reduce((total, row) => total + row.baseline_tokens, 0);
  const treatmentTokens = rows.reduce((total, row) => total + row.treatment_tokens, 0);
  const exact = rows.every((row) => row.tokenizer_exact);
  return {
    samples: rows.length,
    baseline_chars: baseline,
    treatment_chars: treatment,
    avoided_chars: baseline - treatment,
    avoided_approx_text_tokens: Math.max(0, Math.ceil((baseline - treatment) / 4)),
    saving_percent: percent(baseline, treatment),
    baseline_tokens: baselineTokens,
    treatment_tokens: treatmentTokens,
    avoided_tokens: baselineTokens - treatmentTokens,
    exact_token_saving_percent: exact ? percent(baselineTokens, treatmentTokens) : null,
    tokenizer_exact: exact,
  };
}

function compareDirectFamily(name, baselineRows, treatmentRows) {
  const baselineById = new Map(baselineRows.map((row) => [row.id, row]));
  const rows = treatmentRows.map((treatment) => {
    const baseline = baselineById.get(treatment.id);
    if (!baseline) throw new Error(`Missing baseline row for ${name}/${treatment.id}`);
    const featureActivated = treatment.primary_hash !== baseline.primary_hash ||
      treatment.selected_fork_turns !== baseline.selected_fork_turns;
    return {
      id: treatment.id,
      eligible: treatment.eligible,
      ...(treatment.control ? { control: treatment.control } : {}),
      baseline_chars: baseline.visible_chars,
      treatment_chars: treatment.visible_chars,
      saving_percent: percent(baseline.visible_chars, treatment.visible_chars),
      baseline_tokens: baseline.model_visible_tokens,
      treatment_tokens: treatment.model_visible_tokens,
      avoided_tokens: baseline.model_visible_tokens - treatment.model_visible_tokens,
      exact_token_saving_percent: baseline.tokenizer_exact && treatment.tokenizer_exact
        ? percent(baseline.model_visible_tokens, treatment.model_visible_tokens)
        : null,
      tokenizer_exact: baseline.tokenizer_exact && treatment.tokenizer_exact,
      feature_activated: featureActivated,
      exact_recovery: Boolean(treatment.recovery),
      payload_passthrough: Boolean(treatment.payload_passthrough),
      additional_context_chars: treatment.additional_context_chars,
      ...(treatment.absolute_cap != null ? { absolute_cap: treatment.absolute_cap } : {}),
      ...(treatment.capsule_id ? {
        capsule_text_recovery: treatment.capsule_text_recovery,
        capsule_sha_recovery: treatment.capsule_sha_recovery,
        header_sha_recovery: treatment.header_sha_recovery,
      } : {}),
      ...(treatment.history_turns != null ? {
        history_turns: treatment.history_turns,
        original_fork_turns: treatment.original_fork_turns,
        selected_fork_turns: treatment.selected_fork_turns,
      } : {}),
    };
  });
  const eligible = rows.filter((row) => row.eligible);
  const negatives = rows.filter((row) => !row.eligible);
  const activated = eligible.filter((row) => row.feature_activated);
  const falsePositives = negatives.filter((row) => row.feature_activated);
  const passthrough = negatives.filter((row) => row.payload_passthrough);
  return {
    summary: {
      eligible_samples: eligible.length,
      negative_samples: negatives.length,
      activated_samples: activated.length,
      activation_rate_percent: rate(activated.length, eligible.length),
      activated_only: summarizeExposure(activated),
      eligible_corpus: summarizeExposure(eligible),
      mixed: summarizeExposure(rows),
      exact_recovery_pass: eligible.every((row) => row.exact_recovery),
      exact_recovery_rate_percent: rate(
        eligible.filter((row) => row.exact_recovery).length,
        eligible.length
      ),
      false_positive_count: falsePositives.length,
      false_positive_rate_percent: rate(falsePositives.length, negatives.length),
      negative_passthrough_count: passthrough.length,
      negative_passthrough_rate_percent: rate(passthrough.length, negatives.length),
    },
    rows,
  };
}

function compareDetection(name, baseline, treatment) {
  const baselinePositive = new Map(baseline.positives.map((row) => [row.id, row]));
  const baselineNegative = new Map(baseline.negatives.map((row) => [row.id, row]));
  const positives = treatment.positives.map((row) => ({
    ...row,
    baseline_detected: Boolean(baselinePositive.get(row.id)?.detected),
  }));
  const negatives = treatment.negatives.map((row) => ({
    ...row,
    baseline_detected: Boolean(baselineNegative.get(row.id)?.detected),
  }));
  const truePositives = positives.filter((row) => row.detected).length;
  const falsePositives = negatives.filter((row) => row.detected).length;
  return {
    name,
    summary: {
      eligible_samples: positives.length,
      negative_samples: negatives.length,
      treatment_true_positive_count: truePositives,
      treatment_detection_rate_percent: rate(truePositives, positives.length),
      treatment_false_positive_count: falsePositives,
      treatment_false_positive_rate_percent: rate(falsePositives, negatives.length),
      baseline_detection_count: [...positives, ...negatives]
        .filter((row) => row.baseline_detected).length,
      ...(name === "roundtrip_cache_tax" ? {
        duplicate_suppression_rate_percent: rate(
          positives.filter((row) => row.duplicate_suppressed).length,
          positives.length
        ),
        changed_sample_redetection_rate_percent: rate(
          positives.filter((row) => row.changed_sample_detected).length,
          positives.length
        ),
      } : {}),
    },
    positives,
    negatives,
  };
}

function finiteNumbers(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finiteNumbers);
  if (value && typeof value === "object") return Object.values(value).every(finiteNumbers);
  return true;
}

function buildReport(baseline, treatment, tokenAccounting) {
  const direct = {
    control_envelope: compareDirectFamily(
      "control_envelope",
      baseline.direct.control_envelope,
      treatment.direct.control_envelope
    ),
    absolute_output: compareDirectFamily(
      "absolute_output",
      baseline.direct.absolute_output,
      treatment.direct.absolute_output
    ),
    subagent_fork: compareDirectFamily(
      "subagent_fork",
      baseline.direct.subagent_fork,
      treatment.direct.subagent_fork
    ),
  };
  const allRows = Object.values(direct).flatMap((family) => family.rows);
  const eligible = allRows.filter((row) => row.eligible);
  const negatives = allRows.filter((row) => !row.eligible);
  const activated = eligible.filter((row) => row.feature_activated);
  const falsePositives = negatives.filter((row) => row.feature_activated);
  const negativePassthrough = negatives.filter((row) => row.payload_passthrough);
  const sequence = compareDetection(
    "sequence_fuse",
    baseline.detection_only.sequence_fuse,
    treatment.detection_only.sequence_fuse
  );
  const tax = compareDetection(
    "roundtrip_cache_tax",
    baseline.detection_only.roundtrip_cache_tax,
    treatment.detection_only.roundtrip_cache_tax
  );

  const gates = {
    deterministic_seed_recorded: Number.isInteger(SEED),
    exact_tokenizer_available: tokenAccounting.exact &&
      tokenAccounting.encoding === "o200k_base" &&
      tokenAccounting.invocation_count === 1,
    minimum_direct_eligible_samples: eligible.length >= 30,
    minimum_direct_negative_samples: negatives.length >= 30,
    every_direct_family_has_30_eligible_and_30_negative: Object.values(direct).every(
      (family) => family.summary.eligible_samples >= 30 && family.summary.negative_samples >= 30
    ),
    all_direct_eligible_cases_activated: activated.length === eligible.length,
    direct_activated_saving_positive: summarizeExposure(activated).saving_percent > 0 &&
      summarizeExposure(activated).exact_token_saving_percent > 0,
    exact_recovery_complete: eligible.every((row) => row.exact_recovery),
    no_direct_false_positives: falsePositives.length === 0,
    negative_payload_passthrough_complete: negativePassthrough.length === negatives.length,
    absolute_cap_all_eligible: direct.absolute_output.rows
      .filter((row) => row.eligible)
      .every((row) => row.absolute_cap === true),
    sequence_fuse_detects_all_cycles: sequence.summary.treatment_detection_rate_percent === 100,
    sequence_fuse_no_false_positives: sequence.summary.treatment_false_positive_count === 0,
    roundtrip_tax_detects_all_elevated_samples: tax.summary.treatment_detection_rate_percent === 100,
    roundtrip_tax_no_false_positives: tax.summary.treatment_false_positive_count === 0,
    roundtrip_tax_duplicate_suppression_complete: tax.summary.duplicate_suppression_rate_percent === 100,
    roundtrip_tax_changed_sample_redetection_complete:
      tax.summary.changed_sample_redetection_rate_percent === 100,
    env_off_baselines_silent:
      sequence.summary.baseline_detection_count === 0 && tax.summary.baseline_detection_count === 0,
  };

  const report = {
    method: {
      benchmark: "Capsule roundtrip-contract same-codebase environment-toggle A/B",
      version: require("../package.json").version,
      seed: SEED,
      baseline: {
        arm: "A",
        control_envelope: "off",
        absolute_output: "off",
        fork_policy: "off",
        sequence_fuse: "off",
        roundtrip_tax: "off",
      },
      treatment: {
        arm: "B",
        control_envelope: "on",
        absolute_output: "on",
        fork_policy: "auto",
        sequence_fuse: "on",
        roundtrip_tax: "on",
      },
      isolation: "Separate child process and CAPSULE_STATE directory per arm.",
      tokenizer: tokenAccounting,
      direct_savings_scope:
        "Model-visible serialized characters for successful exec envelopes, normal-pressure absolute caps, and estimated subagent fork exposure. Treatment guidance is charged.",
      detection_scope:
        "Sequence-fuse and round-trip cache-tax rows are detection/safety metrics only and are excluded from direct savings totals.",
      token_caveat:
        "Exact payload counts use one Python tiktoken o200k_base batch when available; chars/4 remains a labeled fallback only. Provider caching, output tokens, billing, latency, and inherited image tokens are excluded.",
    },
    summary: {
      direct_eligible_samples: eligible.length,
      direct_negative_samples: negatives.length,
      direct_activated_samples: activated.length,
      direct_activation_rate_percent: rate(activated.length, eligible.length),
      activated_only: summarizeExposure(activated),
      mixed: summarizeExposure(allRows),
      exact_recovery_pass: eligible.every((row) => row.exact_recovery),
      exact_recovery_rate_percent: rate(
        eligible.filter((row) => row.exact_recovery).length,
        eligible.length
      ),
      false_positive_count: falsePositives.length,
      false_positive_rate_percent: rate(falsePositives.length, negatives.length),
      negative_passthrough_count: negativePassthrough.length,
      negative_passthrough_rate_percent: rate(negativePassthrough.length, negatives.length),
      gates,
      safety_pass: Object.values(gates).every(Boolean),
    },
    direct_savings: direct,
    detection_only: {
      sequence_fuse: sequence,
      roundtrip_cache_tax: tax,
    },
  };
  if (!finiteNumbers(report)) throw new Error("Report contains a non-finite number");
  return report;
}

function strictArgument(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return "";
  const value = process.argv[index + 1];
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a path`);
  return value;
}

function summaryView(report) {
  return {
    method: report.method,
    summary: report.summary,
    direct_savings: Object.fromEntries(
      Object.entries(report.direct_savings).map(([name, family]) => [name, family.summary])
    ),
    detection_only: Object.fromEntries(
      Object.entries(report.detection_only).map(([name, family]) => [name, family.summary])
    ),
  };
}

function main() {
  const workerIndex = process.argv.indexOf(WORKER_FLAG);
  if (workerIndex >= 0) {
    const arm = process.argv[workerIndex + 1];
    process.stdout.write(`${JSON.stringify(runWorker(arm))}\n`);
    return;
  }

  const writeTarget = strictArgument("--write");
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-roundtrip-contract-ab-"));
  let report;
  try {
    const baseline = runArm("A", temporaryRoot);
    const treatment = runArm("B", temporaryRoot);
    const tokenAccounting = attachTokenAccounting(baseline, treatment);
    report = buildReport(baseline, treatment, tokenAccounting);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }

  const rendered = `${JSON.stringify(report, null, 2)}\n`;
  if (writeTarget) {
    const destination = path.resolve(writeTarget);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, rendered, "utf8");
  }
  const output = process.argv.includes("--summary")
    ? `${JSON.stringify(summaryView(report), null, 2)}\n`
    : rendered;
  process.stdout.write(output);
  if (!report.summary.safety_pass) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
}
