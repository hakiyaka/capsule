#!/usr/bin/env node
"use strict";

const core = require("./core.cjs");
const unified = require("./unified.cjs");
const tools = require("./schema.cjs");
const packageMetadata = require("../package.json");

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function protocolError(id, code, message) {
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function dispatch(args = {}) {
  const action = args.action === "command"
    ? "run"
    : args.action === "ledger"
      ? "stats"
      : args.action;
  return unified.dispatch({ ...args, action });
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    protocolError(message && message.id, -32600, "Invalid Request");
    return;
  }

  if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
    return;
  }

  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: (message.params && message.params.protocolVersion) || "2025-03-26",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "capsule", version: packageMetadata.version },
      instructions: tools.instructions,
    });
    return;
  }

  if (message.method === "ping") {
    result(message.id, {});
    return;
  }

  if (message.method === "tools/list") {
    result(message.id, { tools });
    return;
  }

  if (message.method === "tools/call") {
    const params = message.params || {};
    try {
      if (params.name !== "capsule") throw new Error(`Unknown tool: ${params.name}`);
      const args = params.arguments || {};
      const operation = await dispatch(args);
      const text = core.renderOperation(operation);
      if (!["ledger", "stats"].includes(args.action)) {
        core.recordExposure(`capsule:${args.action || "unknown"}:${operation.route || "result"}`, operation.capturedChars, text.length);
      }
      result(message.id, { content: [{ type: "text", text }], isError: false });
    } catch (error) {
      const text = JSON.stringify({ error: error.message });
      core.recordExposure("capsule:error", 0, text.length);
      result(message.id, { content: [{ type: "text", text }], isError: true });
    }
    return;
  }

  protocolError(message.id, -32601, `Method not found: ${message.method}`);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  while (true) {
    const newline = input.indexOf("\n");
    if (newline < 0) break;
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!line) continue;
    try {
      Promise.resolve(handle(JSON.parse(line))).catch((error) => {
        protocolError(null, -32603, `Internal error: ${error.message}`);
      });
    } catch (error) {
      protocolError(null, -32700, `Parse error: ${error.message}`);
    }
  }
});

process.stdin.on("end", () => process.exit(0));
process.on("uncaughtException", (error) => {
  process.stderr.write(`capsule fatal: ${error.stack || error.message}\n`);
  process.exit(1);
});
