"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const core = require("../mcp/core.cjs");
const compat = require("../mcp/compat.cjs");
const unified = require("../mcp/unified.cjs");
const terminalNovelty = require("../mcp/terminal-novelty.cjs");
const reasoningResidual = require("../mcp/reasoning-residual.cjs");
const toolchainJit = require("../mcp/toolchain-jit.cjs");
const zeroInferencePoll = require("../mcp/zero-inference-poll.cjs");
const getContent = require("../mcp/get-content.cjs");

function payloadPath() {
  const index = process.argv.indexOf("--payload");
  if (index < 0 || !process.argv[index + 1]) throw new Error("--payload is required");
  const root = path.resolve(core.stateRoot(), "hooks", "payloads");
  const target = path.resolve(process.argv[index + 1]);
  if (path.dirname(target) !== root) throw new Error("payload path is outside the hook payload directory");
  return target;
}

function execute(command, cwd, timeoutMs = 300_000, maxBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const executable = process.platform === "win32" ? "powershell.exe" : "/bin/sh";
    const args = process.platform === "win32"
      ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command]
      : ["-lc", command];
    const child = spawn(executable, args, { cwd, windowsHide: true });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error(`command timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    const collect = (bucket, chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill();
        finish(() => reject(new Error(`command output exceeded ${maxBytes} bytes`)));
      } else bucket.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code, signal) => finish(() => resolve({
      exit_code: code,
      signal,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    })));
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function waitForFilesystemSignal(cwd, timeoutMs, fallbackIntervalMs = 3_000) {
  return new Promise((resolve) => {
    const recursive = process.platform === "win32" || process.platform === "darwin";
    const waitMs = recursive
      ? Math.max(1, timeoutMs)
      : Math.max(1, Math.min(timeoutMs, fallbackIntervalMs));
    let watcher;
    let timer;
    let settled = false;
    const finish = (kind) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (watcher) watcher.close();
      resolve({ kind });
    };
    try {
      watcher = fs.watch(cwd, { recursive }, () => finish("event"));
      watcher.on("error", () => finish("interval"));
    } catch {
      watcher = null;
    }
    timer = setTimeout(
      () => finish(recursive && watcher ? "timeout" : "interval"),
      waitMs
    );
  });
}

function bounded(value, limit = 480) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 14)).trim()} …[truncated]`;
}

async function runOne(payload, command, profile, executor = execute) {
  const started = Date.now();
  const fast = getContent.fastPath({
    command,
    cwd: payload.cwd,
    query: payload.query,
    max_chars: payload.max_chars,
    passthrough_chars: payload.passthrough_chars,
  });
  if (fast) {
    const text = `# stdout\n${fast.exactText}\n# stderr\n`;
    return {
      command,
      profile: fast.profile,
      output: fast.output,
      text,
      capsule_id: fast.capsule_id,
      exit_code: 0,
      elapsed_ms: Date.now() - started,
      fast_path: "get-content-native-file-read",
    };
  }
  const result = await executor(
    command,
    path.resolve(payload.cwd || process.cwd()),
    payload.timeout_ms,
    payload.max_output_bytes
  );
  const text = `# stdout\n${result.stdout}\n# stderr\n${result.stderr}`;
  const saved = core.saveCapsule({
    kind: "hook-command",
    source: JSON.stringify({ command, cwd: payload.cwd }),
    text,
    question: payload.query || "",
    maxChars: payload.max_chars || 1_200,
    details: { ...result, elapsed_ms: Date.now() - started },
  });
  const compact = unified.compressText(text, {
    command,
    cwd: payload.cwd,
    profile,
    query: payload.query,
    max_chars: payload.max_chars,
    passthrough_chars: payload.passthrough_chars,
  });
  const zeroPollPassthrough = zeroInferencePoll.safeCommand(command) && !result.stderr
    ? result.stdout
    : text;
  const baselineOutput = compact.route === "compressed"
    ? `${compact.output}\n\n[Capsule exact capsule: ${saved.response.capsule_id}]`
    : zeroPollPassthrough;
  const novelty = terminalNovelty.terminalNovelty({
    session_id: payload.session_id,
    cwd: payload.cwd,
    command,
    text,
    capsule_id: saved.response.capsule_id,
    baseline_output: baselineOutput,
  });
  const currentOutput = novelty?.output || baselineOutput;
  const residual = reasoningResidual.reasoningResidual({
    session_id: payload.session_id,
    cwd: payload.cwd,
    command,
    text,
    capsule_id: saved.response.capsule_id,
    baseline_output: currentOutput,
    execution_epoch: payload.execution_epoch,
    exit_code: result.exit_code,
  });
  const output = residual?.output || currentOutput;
  compat.recordHistory({
    command,
    cwd: payload.cwd,
    profile: residual?.profile || novelty?.profile || compact.profile,
    route: residual ? "reasoning-residual" : novelty ? "terminal-novelty" : compact.route,
    raw_chars: text.length,
    emitted_chars: output.length,
    exit_code: result.exit_code,
    source: "hook-shell",
  });
  return {
    command,
    profile,
    output,
    text,
    capsule_id: saved.response.capsule_id,
    exit_code: Number.isInteger(result.exit_code) ? result.exit_code : 1,
    elapsed_ms: Date.now() - started,
  };
}

async function runZeroInferencePoll(payload, primary, observation, executor, runtime = {}) {
  const schedule = zeroInferencePoll.plan(payload, observation.candidate);
  const sleep = runtime.sleep || delay;
  const waitForSignal = runtime.waitForSignal || waitForFilesystemSignal;
  const probes = [];
  const started = Date.now();
  let latest = primary;
  let changed = false;
  let probeError = "";
  for (let index = 0; index < schedule.max_probes; index += 1) {
    const elapsed = Date.now() - started;
    const remaining = Math.max(0, schedule.window_ms - elapsed);
    if (!remaining && index > 0) break;
    if (schedule.transport === "filesystem-event") {
      const signal = await waitForSignal(
        observation.candidate.cwd,
        Math.max(1, remaining || schedule.interval_ms),
        schedule.interval_ms
      );
      const kind = typeof signal === "string" ? signal : signal?.kind;
      if (kind === "timeout") break;
      if (kind === "event") await sleep(Math.min(150, schedule.interval_ms));
    } else {
      await sleep(Math.max(1, Math.min(schedule.interval_ms, remaining || schedule.interval_ms)));
    }
    try {
      latest = await runOne({
        ...payload,
        max_chars: Math.min(1_600, Number(payload.max_chars || 1_200)),
        passthrough_chars: Math.min(600, Number(payload.passthrough_chars || 600)),
        timeout_ms: Math.min(60_000, Number(payload.timeout_ms || 60_000)),
      }, payload.command, payload.profile, executor);
    } catch (error) {
      probeError = String(error?.message || error).slice(0, 400);
      break;
    }
    changed = zeroInferencePoll.recordLocal(observation, latest);
    probes.push({
      capsule_id: latest.capsule_id,
      exit_code: latest.exit_code,
      elapsed_ms: latest.elapsed_ms,
      semantic_hash: zeroInferencePoll.semanticHash(latest).slice(0, 24),
      changed,
    });
    if (changed) break;
  }

  const proof = core.saveCapsule({
    kind: "zero-inference-poll",
    source: JSON.stringify({
      session_id: payload.session_id,
      cwd: payload.cwd,
      command: payload.command,
    }),
    text: JSON.stringify({
      version: 1,
      command: payload.command,
      profile: observation.candidate.profile,
      transport: schedule.transport,
      primary: {
        capsule_id: primary.capsule_id,
        exit_code: primary.exit_code,
        semantic_hash: observation.semantic_hash.slice(0, 24),
      },
      probes,
      changed,
      probe_error: probeError || undefined,
    }),
    question: "Recover the exact observations coalesced without model re-entry.",
    maxChars: 1_200,
    details: {
      local_observations: probes.length,
      window_ms: schedule.window_ms,
      context_tokens: observation.context_tokens,
    },
  }).response.capsule_id;
  const state = changed ? "changed" : probeError ? "probe-error" : "quiet";
  const header = `[Capsule zero-inference reactor; ${state}; mode=${schedule.transport}; ` +
    `local=${probes.length}; window=${schedule.window_ms}ms; exact=${proof}]`;
  const output = changed
    ? `${header}\n${latest.output}`
    : probeError
      ? `${primary.output}\n${header}\nprobe=${bounded(probeError, 240)}`
      : header;
  return {
    output,
    exit_code: changed ? latest.exit_code : primary.exit_code,
    macro: [],
    poll: {
      activated: true,
      changed,
      local_observations: probes.length,
      transport: schedule.transport,
      window_ms: schedule.window_ms,
      proof,
      probe_error: probeError || undefined,
    },
    proof,
    estimated_avoided_input_tokens: observation.context_tokens * probes.length,
  };
}

async function runPayload(payload, executor = execute, runtime = {}) {
  const token = toolchainJit.begin(payload);
  const primary = await runOne(payload, payload.command, payload.profile, executor);
  let prediction = toolchainJit.finish(token, primary.exit_code).prediction;
  const pollObservation = zeroInferencePoll.observe(payload, primary);
  if (pollObservation.activate) {
    return runZeroInferencePoll(payload, primary, pollObservation, executor, runtime);
  }
  const contextTokens = Math.max(0, Number(payload.input_tokens || 0));
  const configuredMinimum = Number(process.env.CAPSULE_TOOLCHAIN_JIT_MIN_CONTEXT);
  const minimumContext = Number.isFinite(configuredMinimum)
    ? Math.max(0, Math.trunc(configuredMinimum))
    : 2_000;
  if (!prediction || contextTokens < minimumContext) {
    return { output: primary.output, exit_code: primary.exit_code, macro: [] };
  }

  const macro = [];
  const seen = new Set([toolchainJit.descriptor(payload).signature]);
  const maxSteps = Math.min(3, Math.max(
    1,
    Number(process.env.CAPSULE_TOOLCHAIN_JIT_MAX_STEPS || 2)
  ));
  while (prediction && macro.length < maxSteps) {
    const target = prediction.target;
    if (!toolchainJit.safe(target) || seen.has(target.signature)) break;
    seen.add(target.signature);
    let execution;
    try {
      execution = await runOne({
        ...payload,
        cwd: target.cwd,
        max_chars: Math.min(1_600, Number(payload.max_chars || 1_200)),
        passthrough_chars: Math.min(600, Number(payload.passthrough_chars || 600)),
        timeout_ms: Math.min(60_000, Number(payload.timeout_ms || 60_000)),
      }, target.command, target.profile, executor);
    } catch {
      break;
    }
    macro.push({ prediction, execution });
    prediction = toolchainJit.predict({
      ...payload,
      command: target.command,
      profile: target.profile,
      cwd: target.cwd,
      execution_epoch: target.epoch,
    }, execution.exit_code);
  }
  if (!macro.length) return { output: primary.output, exit_code: primary.exit_code, macro: [] };

  const proof = core.saveCapsule({
    kind: "causal-toolchain-jit",
    source: JSON.stringify({
      session_id: payload.session_id,
      cwd: payload.cwd,
      command: payload.command,
    }),
    text: JSON.stringify({
      version: 1,
      primary: {
        command: primary.command,
        profile: primary.profile,
        exit_code: primary.exit_code,
        capsule_id: primary.capsule_id,
      },
      successors: macro.map(({ prediction: edge, execution }) => ({
        command: execution.command,
        profile: execution.profile,
        exit_code: execution.exit_code,
        capsule_id: execution.capsule_id,
        confidence: edge.confidence,
        observations: edge.observations,
      })),
    }),
    question: "Recover the exact commands and evidence executed by the learned toolchain macro.",
    maxChars: 1_200,
    details: { successors: macro.length, context_tokens: contextTokens },
  }).response.capsule_id;
  const header = `[Capsule JIT+${macro.length}; ` +
    `${macro.map(({ execution }, index) =>
      `J${index + 1}=${bounded(execution.command, 140)} e${execution.exit_code}`
    ).join("; ")}; x=${proof}]`;
  const candidate = [
    primary.output,
    header,
    ...macro.map(({ execution }) => execution.output),
  ].filter(Boolean).join("\n");
  const addedTokens = Math.max(0, core.estimateTokens(candidate) - core.estimateTokens(primary.output));
  const estimatedAvoidedInput = contextTokens * macro.length;
  if (addedTokens + 32 >= estimatedAvoidedInput) {
    return { output: primary.output, exit_code: primary.exit_code, macro: [] };
  }
  const finalExecution = macro.at(-1).execution;
  toolchainJit.setLast({
    ...payload,
    command: finalExecution.command,
    profile: finalExecution.profile,
  }, finalExecution.exit_code);
  return {
    output: candidate,
    exit_code: primary.exit_code,
    macro,
    proof,
    added_tokens: addedTokens,
    estimated_avoided_input_tokens: estimatedAvoidedInput,
  };
}

async function main() {
  if (process.argv[2] !== "shell") throw new Error("supported mode: shell");
  const file = payloadPath();
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.unlinkSync(file);
  const result = await runPayload(payload);
  process.stdout.write(result.output);
  process.exitCode = result.exit_code;
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Capsule wrapper error: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { execute, runPayload, waitForFilesystemSignal };
