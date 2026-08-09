"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const test = require("node:test");

test("plugin MCP config anchors relative paths at the plugin root", () => {
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".mcp.json"), "utf8"));
  const server = config.mcpServers.capsule;
  assert.equal(server.cwd, ".");
  assert.deepEqual(server.args, ["--no-warnings", "./mcp/server.cjs"]);
});

test("skill router CLI remains available when the MCP transport is not hot-loaded", () => {
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-router-cli-"));
  const skill = path.join(codexHome, "skills", "database-guide");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), [
    "---",
    "name: database-guide",
    "description: Diagnose database indexes, query plans, and transaction contention.",
    "---",
  ].join("\n"), "utf8");
  try {
    const result = spawnSync(process.execPath, [
      path.join(__dirname, "..", "scripts", "skill-router.cjs"),
      "route",
      "diagnose a slow database query plan",
    ], {
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        CAPSULE_STATE: path.join(codexHome, "state"),
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const routed = JSON.parse(result.stdout);
    assert.equal(routed.matches[0].name, "database-guide");
    assert.equal(routed.transport, "local-cli");
  } finally {
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test("stdio MCP handshake and tool call", async (context) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-mcp-state-"));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-mcp-work-"));
  const sample = path.join(workspace, "sample.txt");
  fs.writeFileSync(sample, `${"quiet\n".repeat(4000)}ERROR handshake needle\n`, "utf8");

  const server = spawn(process.execPath, [path.join(__dirname, "..", "mcp", "server.cjs")], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, CAPSULE_STATE: state },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => {
    server.kill();
    fs.rmSync(state, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const pending = new Map();
  const reader = readline.createInterface({ input: server.stdout });
  reader.on("line", (line) => {
    const message = JSON.parse(line);
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  });

  let nextId = 1;
  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, 5000);
      pending.set(id, (message) => {
        clearTimeout(timeout);
        resolve(message);
      });
      server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  const initialized = await request("initialize", { protocolVersion: "2025-03-26", capabilities: {} });
  assert.equal(initialized.result.serverInfo.name, "capsule");
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(initialized.result.serverInfo.version, packageJson.version);

  const listed = await request("tools/list");
  assert.equal(listed.result.tools.length, 1);
  assert.equal(listed.result.tools[0].name, "capsule");
  assert.ok(listed.result.tools[0].inputSchema.properties.payload);
  assert.equal(listed.result.tools[0].inputSchema.properties.action.type, "string");
  assert.equal(listed.result.tools[0].inputSchema.properties.action.enum, undefined);
  assert.match(listed.result.tools[0].description, /discover/);

  const surveyed = await request("tools/call", {
    name: "capsule",
    arguments: {
      action: "file",
      payload: { path: sample, query: "handshake needle", max_chars: 2200 },
    },
  });
  assert.equal(surveyed.result.isError, false);
  const body = JSON.parse(surveyed.result.content[0].text);
  assert.match(body.capsule_id, /^cap_[a-f0-9]{16}$/);
  assert.match(JSON.stringify(body), /ERROR handshake needle/);

  const ledger = await request("tools/call", {
    name: "capsule",
    arguments: { action: "ledger" },
  });
  const ledgerBody = JSON.parse(ledger.result.content[0].text);
  assert.equal(ledgerBody.events, 1);
  assert.ok(ledgerBody.captured.approx_tokens > ledgerBody.emitted.approx_tokens);
  assert.equal(ledgerBody.dollar_estimate.model, "gpt-5.6-sol");
  assert.ok(ledgerBody.dollar_estimate.estimated_saved_usd > 0);
  assert.ok(
    ledgerBody.dollar_estimate.range_usd.all_uncached >
    ledgerBody.dollar_estimate.range_usd.all_cached
  );

  const missingPath = path.join(workspace, "private", "missing.txt");
  const failed = await request("tools/call", {
    name: "capsule",
    arguments: { action: "file", payload: { path: missingPath } },
  });
  assert.equal(failed.result.isError, true);
  assert.doesNotMatch(failed.result.content[0].text, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
