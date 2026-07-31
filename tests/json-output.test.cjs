"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-json-output-"));
process.env.CAPSULE_STATE = state;
const unified = require("../mcp/unified.cjs");
const core = require("../mcp/core.cjs");

function parse(output) {
  assert.doesNotThrow(() => JSON.parse(output));
  return JSON.parse(output);
}

test.after(() => {
  unified.closeSearchDatabase();
  fs.rmSync(state, { recursive: true, force: true });
});

test("pretty JSON takes the lossless minification path even below passthrough threshold", () => {
  const value = {
    status: "ok",
    items: Array.from({ length: 5 }, (_, index) => ({
      id: 17 + index,
      url: `https://example.test/${17 + index}`,
      title: `item ${index}`,
    })),
  };
  const raw = JSON.stringify(value, null, 2);
  const compact = unified.compressText(raw, {
    profile: "generic",
    max_chars: 4_000,
    passthrough_chars: 1_000_000,
  });
  assert.equal(compact.route, "compressed");
  assert.equal(compact.json_mode, "lossless-minified");
  assert.deepEqual(parse(compact.output), value);
  assert.ok(compact.output.length < raw.length);
});

test("structured array projection keeps each numeric id paired with its own URL", () => {
  const value = Array.from({ length: 90 }, (_, index) => ({
    id: 10_000 + index,
    url: `https://example.test/item/${10_000 + index}`,
    title: `item ${index}`,
    status: index % 2 ? "ready" : "queued",
    detail: `detail-${index}-` + "x".repeat(220),
    _capsule_source_index: -999,
  }));
  const raw = `# stdout\n${JSON.stringify(value, null, 2)}\n\n# stderr\n`;
  const compact = unified.compressText(raw, { max_chars: 1_400, passthrough_chars: 1_000_000 });
  assert.equal(compact.route, "compressed");
  assert.equal(compact.json_mode, "structured-projection");
  assert.ok(compact.output.length <= 1_400);
  const projected = parse(compact.output);
  assert.ok(projected.capsule_json_projection.omitted_items > 0);
  assert.ok(projected.items.length > 0);
  for (const item of projected.items) {
    const source = value[item._capsule_source_index];
    assert.equal(item.id, source.id);
    assert.equal(item.url, source.url);
    assert.equal(item.status, source.status);
    assert.equal(item.url, `https://example.test/item/${item.id}`);
  }
});

test("query-aware projection retains a matching record and its associations", () => {
  const value = Array.from({ length: 100 }, (_, index) => ({
    id: index,
    url: `https://example.test/${index}`,
    title: index === 77 ? "needle-unique target record" : `ordinary record ${index}`,
    payload: "z".repeat(180),
  }));
  const compact = unified.compressText(JSON.stringify(value, null, 2), {
    query: "needle-unique",
    max_chars: 900,
  });
  assert.equal(compact.json_mode, "structured-projection");
  const projected = parse(compact.output);
  const hit = projected.items.find((item) => item._capsule_source_index === 77);
  assert.ok(hit);
  assert.equal(hit.id, 77);
  assert.equal(hit.url, "https://example.test/77");
  assert.match(JSON.stringify(hit), /needle-unique/);
  assert.equal(projected.capsule_json_projection.query_matches_total, 1);
  assert.equal(projected.capsule_json_projection.query_matches_shown, 1);
});

test("query-aware projection searches nested result arrays without flattening records", () => {
  const matches = Array.from({ length: 70 }, (_, index) => ({
    id: 500 + index,
    url: `https://nested.test/${500 + index}`,
    title: index === 55 ? "critical-sprocket match" : `match ${index}`,
    body: "q".repeat(180),
  }));
  const compact = unified.compressText(JSON.stringify({ status: "ok", matches }, null, 2), {
    query: "critical-sprocket",
    max_chars: 1_100,
  });
  assert.equal(compact.json_mode, "structured-projection");
  const projected = parse(compact.output);
  const nested = projected.value.matches;
  const hit = nested.items.find((item) => item._capsule_source_index === 55);
  assert.ok(hit);
  assert.equal(hit.id, 555);
  assert.equal(hit.url, "https://nested.test/555");
  assert.match(JSON.stringify(hit), /critical-sprocket/);
  assert.equal(nested._capsule_array.omitted_items, matches.length - nested.items.length);
});

test("JSON secret fields and secret-bearing strings are recursively redacted without breaking JSON", () => {
  const raw = JSON.stringify({
    token: "top-secret-token",
    nested: {
      password: "test-fixture-password-91",
      message: "authorization: Bearer abc.def.ghi",
      safe: "visible",
    },
  }, null, 2);
  const compact = unified.compressText(raw, { max_chars: 4_000 });
  const value = parse(compact.output);
  assert.equal(value.token, "[REDACTED]");
  assert.equal(value.nested.password, "[REDACTED]");
  assert.equal(value.nested.safe, "visible");
  assert.doesNotMatch(compact.output, /top-secret-token|hunter2|abc\.def\.ghi/);
  assert.ok(compact.secret_redactions >= 3);
  assert.equal(compact.json_mode, "redacted-minified");
  assert.equal(compact.security_reason, "secret-redaction");
});

test("small JSON envelope passes through instead of growing for a wrapper", () => {
  const raw = "# stdout\n{\"ok\":true}\n# stderr\nx";
  const compact = unified.compressText(raw, { max_chars: 4_000 });
  assert.equal(compact.route, "passthrough");
  assert.equal(compact.output, raw);
  assert.ok(compact.output.length <= raw.length);
});

test("inventory overflow uses valid lossless passthrough instead of an unsafe bounded projection", () => {
  const value = Array.from({ length: 20_100 }, (_, index) => index);
  const compact = unified.compressText(JSON.stringify(value), { max_chars: 600 });
  assert.equal(compact.route, "passthrough");
  assert.equal(compact.json_mode, "lossless-passthrough");
  assert.deepEqual(parse(compact.output), value);
});

test("non-JSON and diff paths retain their existing content-aware filters", () => {
  const prose = Array.from({ length: 80 }, (_, index) => `ordinary prose line ${index}`).join("\n");
  const generic = unified.compressText(prose, { profile: "generic", max_chars: 900, passthrough_chars: 0 });
  assert.equal(generic.json_mode, undefined);
  assert.match(generic.output, /ordinary prose line/);

  const diff = [
    "diff --git a/a.cjs b/a.cjs",
    "@@ old:10..12 new:10..13 @@",
    "+first",
    "@@ old:80..82 new:81..83 @@",
    "+second",
  ].join("\n");
  const compactDiff = unified.compressText(diff, { profile: "diff", max_chars: 900, passthrough_chars: 0 });
  assert.equal(compactDiff.json_mode, undefined);
  assert.match(compactDiff.output, /old:10\.\.12/);
  assert.match(compactDiff.output, /old:80\.\.82/);
});


test("camelCase secret keys and adversarial object keys remain safe and parseable", () => {
  delete Object.prototype.polluted;
  const raw = "{\"__proto__\":{\"polluted\":true},\"apiKey\":\"api-secret\",\"refresh_token\":\"refresh-secret\",\"context_token_limit\":233000,\"id\":4}";
  const compact = unified.compressText(raw, { max_chars: 4_000 });
  const value = parse(compact.output);
  assert.equal(value.apiKey, "[REDACTED]");
  assert.equal(value.refresh_token, "[REDACTED]");
  assert.equal(value.context_token_limit, 233000);
  assert.equal(value.id, 4);
  assert.deepEqual(value.__proto__, { polluted: true });
  assert.equal(Object.prototype.polluted, undefined);
  assert.doesNotMatch(compact.output, /api-secret|refresh-secret/);
});

test("run keeps exact archived JSON recovery while returning a parseable bounded projection", () => {
  const script = [
    "const rows=Array.from({length:40},(_,i)=>({id:i,url:'https://run.test/'+i,title:i===35?'run-needle':'row '+i,body:'x'.repeat(160)}));",
    "console.log(JSON.stringify(rows,null,2));",
  ].join("");
  const operation = unified.runCommand({
    command: process.execPath,
    args: ["-e", script],
    query: "run-needle",
    max_chars: 800,
  });
  assert.match(operation.response.capsule_id, /^cap_[a-f0-9]{16}$/);
  assert.equal(operation.response.json_mode, "structured-projection");
  const projected = parse(operation.response.output);
  const hit = projected.items.find((item) => item._capsule_source_index === 35);
  assert.equal(hit.id, 35);
  assert.equal(hit.url, "https://run.test/35");
  const exact = core.loadCapsule(operation.response.capsule_id).text;
  assert.match(exact, /\"id\": 35/);
  assert.match(exact, /https:\/\/run\.test\/35/);
});


test("oversized JSON stdout with stderr still projects safely and retains the query record", () => {
  const rows = Array.from({ length: 60 }, (_, index) => ({
    id: 700 + index,
    url: `https://stderr.test/${700 + index}`,
    title: index === 48 ? "stderr-needle row" : `row ${index}`,
    body: "w".repeat(180),
  }));
  const raw = `# stdout\n${JSON.stringify(rows, null, 2)}\n\n# stderr\nwarning: diagnostic stream retained\n`;
  const compact = unified.compressText(raw, { query: "stderr-needle", max_chars: 1_100 });
  assert.equal(compact.json_mode, "structured-projection");
  const projected = parse(compact.output);
  assert.equal(projected.value.stderr, "warning: diagnostic stream retained");
  const hit = projected.value.stdout.items.find((item) => item._capsule_source_index === 48);
  assert.equal(hit.id, 748);
  assert.equal(hit.url, "https://stderr.test/748");
  assert.match(JSON.stringify(hit), /stderr-needle/);
});


test("tiny JSON formatting wins stay passthrough after activation overhead is counted", () => {
  const raw = "{\n  \"id\": 1\n}";
  const compact = unified.compressText(raw, { max_chars: 4_000, passthrough_chars: 1_000_000 });
  assert.equal(compact.route, "passthrough");
  assert.equal(compact.output, raw);
  assert.equal(compact.json_mode, undefined);
});

test("long identity URLs use an explicit hashed preview and keep record provenance", () => {
  const rows = Array.from({ length: 24 }, (_, index) => ({
    id: 900 + index,
    url: `https://long.test/${"a".repeat(700)}${index === 19 ? "needle-long" : "ordinary"}${"b".repeat(700)}/${900 + index}`,
    title: `long row ${index}`,
    body: "v".repeat(180),
    _capsule_source_index: -1,
  }));
  const compact = unified.compressText(JSON.stringify(rows, null, 2), {
    query: "needle-long",
    max_chars: 1_800,
  });
  assert.equal(compact.json_mode, "structured-projection");
  assert.ok(compact.output.length <= 1_800);
  const projected = parse(compact.output);
  const hit = projected.items.find((item) => item._capsule_source_index === 19);
  assert.ok(hit);
  assert.equal(hit.id, 919);
  assert.equal(typeof hit.url, "object");
  assert.equal(hit.url._capsule_chars, rows[19].url.length);
  assert.ok(hit.url._capsule_omitted_chars > 0);
  assert.match(hit.url._capsule_text_preview, /needle-long/);
  assert.match(hit.url._capsule_sha256, /^[a-f0-9]{16}$/);
});


test("query-selected error records retain identity, status, and diagnostics together", () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({
    id: 1_500 + index,
    url: `https://errors.test/${1_500 + index}`,
    status: index === 31 ? "failed" : "ok",
    error: index === 31 ? "fatal-needle database timeout" : null,
    message: index === 31 ? "retry disabled" : "completed",
    detail: "d".repeat(180),
  }));
  const compact = unified.compressText(JSON.stringify(rows, null, 2), {
    query: "fatal-needle",
    max_chars: 1_000,
  });
  const projected = parse(compact.output);
  const hit = projected.items.find((item) => item._capsule_source_index === 31);
  assert.ok(hit);
  assert.equal(hit.id, 1_531);
  assert.equal(hit.url, "https://errors.test/1531");
  assert.equal(hit.status, "failed");
  assert.equal(hit.error, "fatal-needle database timeout");
  assert.equal(hit.message, "retry disabled");
});


test("deep adversarial JSON is sanitized and serialized without recursive stack overflow", () => {
  let raw = "{\"token\":\"deep-secret-needle\"}";
  for (let depth = 0; depth < 12_000; depth += 1) raw = `{\"a\":${raw}}`;
  let compact;
  assert.doesNotThrow(() => {
    compact = unified.compressText(raw, { max_chars: 600 });
  });
  assert.equal(compact.route, "passthrough");
  assert.equal(compact.json_mode, "redacted-passthrough");
  assert.equal(compact.secret_redactions, 1);
  assert.doesNotMatch(compact.output, /deep-secret-needle/);
  assert.match(compact.output, /\[REDACTED\]/);
  assert.doesNotThrow(() => JSON.parse(compact.output));
});

test("PostToolUse emits a security-redacted passthrough instead of exposing raw JSON", () => {
  const hook = require("../scripts/hook.cjs");
  const priorGovernor = process.env.CAPSULE_REASONING_GOVERNOR;
  const priorWire = process.env.CAPSULE_HOOK_WIRE;
  process.env.CAPSULE_REASONING_GOVERNOR = "0";
  process.env.CAPSULE_HOOK_WIRE = "1";
  try {
    const raw = JSON.stringify({
      token: "hook-secret-needle",
      data: Array.from({ length: 20_050 }, () => 0),
    });
    const result = hook.postToolUse({
      tool_name: "custom_write",
      tool_response: raw,
      session_id: `json-security-${process.pid}-${Date.now()}`,
      cwd: process.cwd(),
    });
    assert.equal(result.continue, false);
    assert.match(result.reason, /\[REDACTED\]/);
    assert.doesNotMatch(result.reason, /hook-secret-needle/);
    assert.doesNotThrow(() => JSON.parse(result.reason));
    const securityContext = result.hookSpecificOutput.additionalContext;
    assert.match(securityContext, /\[Capsule security redaction; exact=cap_[a-f0-9]{16}\]/);
    const capsuleId = securityContext.match(/exact=(cap_[a-f0-9]{16})/)?.[1];
    assert.ok(capsuleId);
    assert.match(core.loadCapsule(capsuleId).text, /hook-secret-needle/);
  } finally {
    if (priorGovernor == null) delete process.env.CAPSULE_REASONING_GOVERNOR;
    else process.env.CAPSULE_REASONING_GOVERNOR = priorGovernor;
    if (priorWire == null) delete process.env.CAPSULE_HOOK_WIRE;
    else process.env.CAPSULE_HOOK_WIRE = priorWire;
  }
});
