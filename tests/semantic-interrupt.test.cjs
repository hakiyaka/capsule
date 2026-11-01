"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { semanticInterrupt } = require("../mcp/semantic-interrupt.cjs");

test("command probes respect the semantic-interrupt deadline", async () => {
  const started = Date.now();
  const result = await semanticInterrupt({
    interval_ms: 25,
    timeout_ms: 100,
    probes: [{
      id: "slow-command",
      type: "command",
      idempotent: true,
      command: process.execPath,
      args: ["-e", "setTimeout(() => {}, 5_000)"],
    }],
  });

  assert.equal(result.response.timed_out, true);
  assert.ok(Date.now() - started < 1_000, "command probe outlived interrupt deadline");
});

test("a later command probe timeout is not reported as a change", async (context) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-interrupt-deadline-"));
  context.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const marker = path.join(workspace, "baseline-ready");
  const result = await semanticInterrupt({
    interval_ms: 25,
    timeout_ms: 1_000,
    probes: [{
      id: "later-stall",
      type: "command",
      idempotent: true,
      command: process.execPath,
      args: ["-e", [
        "const fs = require('node:fs');",
        "if (fs.existsSync(process.argv[1])) setTimeout(() => {}, 5_000);",
        "else fs.writeFileSync(process.argv[1], 'ready');",
      ].join("\n"), marker],
    }],
  });

  assert.ok(result.response.checks >= 2, "the baseline must complete before the stalled poll");
  assert.equal(result.response.timed_out, true);
  assert.equal(result.response.changed, false);
});

test("URL probes respect the interrupt deadline while receiving a stalled body", async (context) => {
  const sockets = new Set();
  const server = http.createServer((_request, response) => {
    response.writeHead(200);
    response.write("unfinished");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  context.after(() => new Promise((resolve) => {
    for (const socket of sockets) socket.destroy();
    server.close(resolve);
  }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const started = Date.now();
  const result = await semanticInterrupt({
    interval_ms: 25,
    timeout_ms: 100,
    probes: [{
      id: "slow-url",
      type: "url",
      url: `http://127.0.0.1:${server.address().port}/`,
      request_timeout_ms: 1_000,
    }],
  });

  assert.equal(result.response.timed_out, true);
  assert.equal(result.response.changed, false);
  assert.ok(Date.now() - started < 800, "URL probe outlived interrupt deadline");

  await assert.rejects(semanticInterrupt({
    interval_ms: 25,
    timeout_ms: 2_000,
    probes: [{
      id: "request-timeout",
      type: "url",
      url: `http://127.0.0.1:${server.address().port}/`,
      request_timeout_ms: 500,
    }],
  }), { name: "AbortError" });
});
