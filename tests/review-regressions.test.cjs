"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Worker } = require("node:worker_threads");
const { gzipSync } = require("node:zlib");
const test = require("node:test");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-review-regressions-"));
process.env.CAPSULE_STATE = path.join(root, "state");
const core = require("../mcp/core.cjs");
const edit = require("../mcp/edit.cjs");
const unified = require("../mcp/unified.cjs");
const runtime = require("../mcp/runtime.cjs");

test.after(() => {
  unified.closeSearchDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function textOf(operation) {
  return core.loadCapsule(operation.response.results[0].documents[0].capsule_id).text;
}

test("fetch cache separates merged authorization and normalizes header names", async t => {
  const received = [];
  const url = await serve(t, (req, res) => {
    received.push(req.headers.authorization);
    res.end(`response for ${req.headers.authorization}`);
  });
  const request = { url, headers: { "X-Fixture": "review" } };
  const a = await unified.fetchAndIndex({ headers: { Authorization: "fixture-A" }, requests: [request] });
  const b = await unified.fetchAndIndex({ headers: { authorization: "fixture-B" }, requests: [request] });
  const cachedA = await unified.fetchAndIndex({ headers: { authorization: "fixture-A" }, requests: [request] });
  assert.deepEqual(received, ["fixture-A", "fixture-B"]);
  assert.equal(textOf(a), "response for fixture-A");
  assert.equal(textOf(b), "response for fixture-B");
  assert.equal(textOf(cachedA), "response for fixture-A");
  assert.equal(cachedA.response.results[0].cached, true);
  const overridden = await unified.fetchAndIndex({
    headers: { Authorization: "ignored-default" },
    requests: [{ url, headers: { authorization: "fixture-B", "x-fixture": "review" } }],
  });
  assert.equal(textOf(overridden), "response for fixture-B");
  assert.equal(overridden.response.results[0].cached, true);
  assert.equal(received.length, 2);
});

test("fetch cannot reuse legacy keys that omitted default authorization", async t => {
  let requests = 0;
  const url = await serve(t, (_req, res) => { requests += 1; res.end("fresh identity"); });
  const headers = { "x-fixture": "legacy" };
  const key = crypto.createHash("sha256").update(JSON.stringify({ url, headers })).digest("hex");
  const cacheFile = path.join(core.stateRoot(), "index", "fetch-cache.json");
  const cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  cache.entries[key] = { fetched_at_ms: Date.now(), response: { bytes: 0, documents: [], legacy: true } };
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
  const result = await unified.fetchAndIndex({ headers: { Authorization: "new-identity" }, requests: [{ url, headers }] });
  assert.equal(requests, 1);
  assert.equal(textOf(result), "fresh identity");
});

test("fetch refresh works for batch defaults and explicit per-request overrides", async t => {
  let requests = 0;
  const url = await serve(t, (_req, res) => res.end(`version ${++requests}`));
  await unified.fetchAndIndex({ requests: [{ url }] });
  assert.equal(textOf(await unified.fetchAndIndex({ refresh: true, requests: [{ url }] })), "version 2");
  const override = await unified.fetchAndIndex({ refresh: true, requests: [{ url, refresh: false }] });
  assert.equal(override.response.results[0].cached, true);
  assert.equal(requests, 2);
  assert.equal(textOf(await unified.fetchAndIndex({ url, refresh: true })), "version 3");
});

test("fetch cancels an oversized stream without consuming the rest of the body", async () => {
  const originalFetch = global.fetch;
  let pulls = 0;
  let cancelled = false;
  global.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(4096));
      if (pulls === 64) controller.close();
    },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/plain" } });
  try {
    await assert.rejects(unified.fetchAndIndex({ url: "http://fixture.invalid/oversized", max_bytes: 1024 }), /exceeded max_bytes/);
    assert.equal(cancelled, true);
    assert.ok(pulls <= 2, `consumed ${pulls} chunks before rejecting`);
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetch accepts an exact-size body and limits decompressed gzip bytes", async t => {
  const url = await serve(t, (req, res) => {
    if (req.url === "/gzip") {
      const compressed = gzipSync("x".repeat(1024 * 1024));
      res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" });
      res.end(compressed);
    } else if (req.url === "/empty") {
      res.writeHead(204);
      res.end();
    } else res.end("x".repeat(1024));
  });
  const exact = await unified.fetchAndIndex({ url, max_bytes: 1024 });
  assert.equal(exact.response.results[0].bytes, 1024);
  assert.equal(textOf(exact), "x".repeat(1024));
  await assert.rejects(unified.fetchAndIndex({ url: `${url}/gzip`, max_bytes: 1024 }), /exceeded max_bytes/);
  assert.equal((await unified.fetchAndIndex({ url: `${url}/empty` })).response.results[0].bytes, 0);
});

test("fetch tolerates invalid numeric HTML entities while preserving valid Unicode", async t => {
  const url = await serve(t, (_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<html><p>ok &#1114112; &#xD800; &#0; &#${"9".repeat(400)}; &#x1F603;</p></html>`);
  });
  const result = await unified.fetchAndIndex({ url });
  assert.match(textOf(result), /ok \uFFFD \uFFFD \uFFFD \uFFFD 😃/);
});

test("before and after all preserve every anchor in committed file edits", () => {
  const file = path.join(root, "anchors.txt");
  for (const [op, expected] of [["before", "!x !x"], ["after", "x! x!"], ["b", "!x !x"], ["a", "x! x!"]]) {
    fs.writeFileSync(file, "x x");
    edit.edit({ path: file, root, edits: [{ op, anchor: "x", text: "!", all: true }] });
    assert.equal(fs.readFileSync(file, "utf8"), expected, op);
  }
  fs.writeFileSync(file, "x x");
  assert.throws(() => edit.edit({ path: file, root, edits: [{ op: "unknown", find: "x", text: "!", all: true }] }), /unknown edit/);
  assert.equal(fs.readFileSync(file, "utf8"), "x x");
});

test("atomic edits preserve existing POSIX permission bits", { skip: process.platform === "win32" }, () => {
  const file = path.join(root, "executable.sh");
  fs.writeFileSync(file, "echo before\n", { mode: 0o700 });
  edit.edit({ path: file, root, edits: [["replace", "before", "after"]] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o700);
});

test("equal contents retain independent source and kind identities for baseline edits", () => {
  const a = path.join(root, "a.txt");
  const b = path.join(root, "b.txt");
  fs.writeFileSync(a, "same line\n");
  fs.writeFileSync(b, "same line\n");
  const ca = core.surveyFile({ path: a }).response.capsule_id;
  const cb = core.surveyFile({ path: b }).response.capsule_id;
  const command = core.saveCapsule({ kind: "command", source: a, text: "same line\n" }).response.capsule_id;
  assert.equal(new Set([ca, cb, command]).size, 3);
  assert.equal(core.surveyFile({ path: a }).response.capsule_id, ca);
  assert.equal(core.loadCapsule(ca).metadata.source, a);
  assert.equal(core.loadCapsule(ca).metadata.kind, "file");
  edit.edit({ path: a, root, baseline_capsule_id: ca, edits: [["lines", 1, 1, "updated"]] });
  assert.equal(fs.readFileSync(a, "utf8"), "updated\n");
  assert.equal(fs.readFileSync(b, "utf8"), "same line\n");
  assert.equal(core.loadCapsule(ca).text, "same line\n");
});

test("legacy content-only capsule IDs remain readable and linked after saving a new version", () => {
  const text = "legacy bytes\n";
  const source = "fixture://legacy";
  const contentHash = crypto.createHash("sha256").update(text).digest("hex");
  const oldId = `cap_${contentHash.slice(0, 16)}`;
  fs.writeFileSync(path.join(core.stateRoot(), "capsules", `${oldId}.txt.gz`), gzipSync(text));
  fs.writeFileSync(path.join(core.stateRoot(), "metadata", `${oldId}.json`), JSON.stringify({
    capsule_id: oldId, kind: "file", source, sha256: contentHash, created_at: new Date().toISOString(),
  }));
  const sourceFile = path.join(core.stateRoot(), "sources.json");
  const sources = JSON.parse(fs.readFileSync(sourceFile, "utf8"));
  sources[crypto.createHash("sha256").update(`file\0${source}`).digest("hex")] = oldId;
  fs.writeFileSync(sourceFile, JSON.stringify(sources));
  const current = core.saveCapsule({ kind: "file", source, text: "new bytes\n" });
  assert.equal(current.response.previous_capsule_id, oldId);
  assert.equal(core.loadCapsule(oldId).text, text);
});

test("concurrent saves and cache maintenance preserve all source updates", { timeout: 20000 }, async () => {
  const state = path.join(root, "concurrent-state");
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, "sources.json"), "{}");
  const shared = new SharedArrayBuffer(4);
  const count = 4;
  const workerCode = `
    const {workerData} = require('node:worker_threads');
    const fs = require('node:fs');
    const path = require('node:path');
    process.env.CAPSULE_STATE = workerData.state;
    const core = require(workerData.module);
    const barrier = new Int32Array(workerData.shared);
    Atomics.add(barrier,0,1); Atomics.notify(barrier,0);
    while(Atomics.load(barrier,0)<workerData.count) Atomics.wait(barrier,0,Atomics.load(barrier,0),100);
    const originalRead = fs.readFileSync;
    fs.readFileSync = function(file,...args) {
      const result = originalRead.call(this,file,...args);
      if(path.resolve(String(file))===path.join(workerData.state,'sources.json'))
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
      return result;
    };
    for(let i=0;i<3;i++) {
      core.saveCapsule({kind:'file',source:'writer-'+workerData.id+'-'+i,text:'value-'+workerData.id+'-'+i});
      core.maintainCapsuleCache({max_entries:1000,min_recent:0});
    }
  `;
  const workers = [];
  try {
    await Promise.all(Array.from({ length: count }, (_, id) => new Promise((resolve, reject) => {
      const worker = new Worker(workerCode, { eval: true, workerData: {
        id, count, state, shared, module: require.resolve("../mcp/core.cjs"),
      } });
      workers.push(worker);
      worker.once("error", reject);
      worker.once("exit", code => code === 0 ? resolve() : reject(new Error(`writer exited ${code}`)));
    })));
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()));
  }
  const sources = JSON.parse(fs.readFileSync(path.join(state, "sources.json"), "utf8"));
  assert.equal(Object.keys(sources).length, count * 3);
  for (const id of Object.values(sources)) {
    assert.ok(fs.existsSync(path.join(state, "capsules", `${id}.txt.gz`)));
  }
  assert.equal(fs.existsSync(path.join(state, "capsule-sources.lock")), false);
});

test("source lock is released after save failure", () => {
  assert.throws(() => core.saveCapsule({ kind: "file", source: "fixture://invalid", text: null }));
  assert.equal(fs.existsSync(path.join(core.stateRoot(), "capsule-sources.lock")), false);
  assert.ok(core.saveCapsule({ kind: "file", source: "fixture://valid", text: "ok" }).response.capsule_id);
});

test("hook install, reinstall and removal preserve foreign hook paths", () => {
  const home = path.join(root, "hooks-home");
  fs.mkdirSync(home);
  const config = path.join(home, "hooks.json");
  const foreign = [
    'node "C:/example/other-plugin/scripts/hook.cjs" pretooluse',
    'node "/example/other-plugin/capsule-hook.cjs" pretooluse',
    "keep-me",
  ];
  const ownedDirect = `"${process.execPath}" "${path.resolve(__dirname, "../scripts/hook.cjs")}" pretooluse`;
  fs.writeFileSync(config, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks:
    [...foreign, ownedDirect].map(command => ({ type: "command", command })),
  }] } }));
  const installer = path.resolve(__dirname, "../scripts/install-hooks.cjs");
  const run = operation => {
    const child = spawnSync(process.execPath, [installer, operation], {
      env: { ...process.env, CODEX_HOME: home, CAPSULE_HOOKS_FEATURE: "0" },
      encoding: "utf8", windowsHide: true, timeout: 10000,
    });
    assert.equal(child.status, 0, child.stderr);
    return Object.values(JSON.parse(fs.readFileSync(config, "utf8")).hooks)
      .flatMap(entries => entries.flatMap(entry => entry.hooks.map(hook => hook.command)));
  };
  for (const operation of ["install", "install"]) {
    const commands = run(operation);
    assert.equal(commands.length, foreign.length + 6);
    for (const command of foreign) assert.ok(commands.includes(command));
    assert.ok(!commands.includes(ownedDirect));
  }
  assert.deepEqual(run("remove-global"), foreign);
});

test("missing background runtime rejects without crashing or leaving job artifacts", () => {
  const state = path.join(root, "missing-runtime-state");
  const empty = path.join(root, "empty-path");
  fs.mkdirSync(empty);
  const code = `
    const fs = require('node:fs');
    let scratch;
    const original = fs.mkdtempSync;
    fs.mkdtempSync = function(prefix,...args) { const result=original.call(this,prefix,...args); if(String(prefix).includes('capsule-exec-')) scratch=result; return result; };
    const runtime = require(${JSON.stringify(require.resolve("../mcp/runtime.cjs"))});
    runtime.executeCode(${JSON.stringify({ language: "python", code: "print(1)", background: true, env: { PATH: empty, Path: empty } })})
      .then(()=>{process.exitCode=2;})
      .catch(error=>console.log(JSON.stringify({code:error.code,scratchExists:fs.existsSync(scratch),jobs:runtime.jobs().response.jobs.length})));
  `;
  const child = spawnSync(process.execPath, ["-e", code], {
    env: { ...process.env, CAPSULE_STATE: state }, encoding: "utf8", windowsHide: true, timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { code: "ENOENT", scratchExists: false, jobs: 0 });
  assert.deepEqual(fs.readdirSync(path.join(state, "jobs")), []);
});

test("successful background launch still publishes a usable job and runs the program", async () => {
  const marker = path.join(root, "background-result.txt");
  const result = await runtime.executeCode({
    language: "javascript", background: true,
    code: `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'completed');`,
  });
  const job = result.response;
  assert.ok(Number.isInteger(job.pid) && job.pid > 0);
  assert.equal(runtime.jobs({ operation: "status", job_id: job.job_id }).response.pid, job.pid);
  const deadline = Date.now() + 5000;
  while ((!fs.existsSync(marker) || runtime.jobs({ operation: "status", job_id: job.job_id }).response.running) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  try {
    assert.equal(fs.readFileSync(marker, "utf8"), "completed");
    assert.equal(runtime.jobs({ operation: "status", job_id: job.job_id }).response.running, false);
  } finally {
    if (runtime.jobs({ operation: "status", job_id: job.job_id }).response.running) process.kill(job.pid);
    await fs.promises.rm(job.scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
