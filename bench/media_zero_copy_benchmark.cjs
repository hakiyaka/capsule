"use strict";

// Experimental, opt-in media lease benchmark. Image bytes remain exact;
// only the model-visible tool envelope is replaced by a local content handle.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const previousState = process.env.CAPSULE_STATE;
const previousMode = process.env.CAPSULE_MEDIA_ZERO_COPY;
const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-media-zero-copy-"));
process.env.CAPSULE_STATE = state;
process.env.CAPSULE_MEDIA_ZERO_COPY = "1";

const hook = require("../scripts/hook.cjs");

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function percent(before, after) {
  return Number(((before - after) / before * 100).toFixed(2));
}

function runCase(name, imageByte, detail = "high") {
  const output = {
    content: [{
      type: "image",
      image_url: `data:image/png;base64,${Buffer.alloc(imageByte, name.charCodeAt(0)).toString("base64")}`,
    }],
    metadata: { name, detail, stable: true },
  };
  const raw = JSON.stringify(output);
  const result = hook.handle("posttooluse", {
    tool_name: "view_image",
    tool_input: { path: `${name}.png`, detail, capsule_media_zero_copy: true },
    tool_output: output,
    cwd: process.cwd(),
    session_id: `media-zero-copy-${name}`,
  });
  assert.equal(result.continue, false, `${name} did not use a media lease`);
  const reference = JSON.parse(result.reason);
  assert.equal(reference.visual_fidelity, "exact-bytes");
  assert.equal(fs.readFileSync(reference.exact_path, "utf8"), raw);
  assert.equal(reference.exact_sha256, sha256(raw));
  assert.doesNotMatch(result.reason, /data:image\//);
  const after = result.reason.length + String(result.hookSpecificOutput?.additionalContext || "").length;
  return {
    name,
    before_chars: raw.length,
    after_chars: after,
    saving_percent: percent(raw.length, after),
    exact_recovery: true,
  };
}

try {
  const cases = [
    runCase("first", 256 * 1024, "high"),
    runCase("last", 256 * 1024, "original"),
    runCase("repeat", 256 * 1024, "high"),
    runCase("new-turn", 256 * 1024, "high"),
    runCase("detail-escalation", 256 * 1024, "original"),
  ];
  const output = {
    benchmark: "media-zero-copy-lossless",
    method: "Exact local media lease; only serialized tool envelope is replaced.",
    caveat: "Not a provider image-token or billing measurement; visual fidelity is proven by byte-for-byte recovery.",
    safety_pass: cases.every((item) => item.exact_recovery && item.saving_percent > 0),
    cases,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  if (!output.safety_pass) process.exitCode = 1;
} finally {
  if (previousState == null) delete process.env.CAPSULE_STATE;
  else process.env.CAPSULE_STATE = previousState;
  if (previousMode == null) delete process.env.CAPSULE_MEDIA_ZERO_COPY;
  else process.env.CAPSULE_MEDIA_ZERO_COPY = previousMode;
  fs.rmSync(state, { recursive: true, force: true });
}
