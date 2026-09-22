#!/usr/bin/env node
"use strict";

const core = require("./core.cjs");
const unified = require("./unified.cjs");
const tools = require("./schema.cjs");
const packageMetadata = require("../package.json");
const PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26"]);
const MAX_MESSAGE_BYTES = Math.min(128 * 1024 * 1024, Math.max(1024,
  Number.parseInt(process.env.CAPSULE_MCP_MAX_MESSAGE_BYTES, 10) || 16 * 1024 * 1024));

function errorSummary(error) {
  const name = String(error?.name || "Error").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80) || "Error";
  const code = error?.code == null
    ? ""
    : ` (${String(error.code).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40)})`;
  if (process.env.CAPSULE_VERBOSE_ERRORS === "1") {
    const detail = String(error?.message || error || "").replace(/[\r\n\t]+/g, " ").slice(0, 240);
    return `${name}${code}: ${detail}`;
  }
  return `${name}${code}`;
}

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
  const hasId = message != null && Object.prototype.hasOwnProperty.call(message, "id");
  const validId = !hasId || message.id === null || typeof message.id === "string" ||
    (typeof message.id === "number" && Number.isFinite(message.id));
  if (!message || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" || !validId) {
    protocolError(validId ? message?.id : null, -32600, "Invalid Request");
    return;
  }

  if (!hasId) {
    return;
  }
  if (message.params != null && (typeof message.params !== "object" || Array.isArray(message.params))) {
    protocolError(message.id, -32602, "params must be an object");
    return;
  }

  if (message.method === "initialize") {
    result(message.id, {
      protocolVersion: PROTOCOL_VERSIONS.has(message.params?.protocolVersion) ? message.params.protocolVersion : "2025-03-26",
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
      const text = JSON.stringify({ error: errorSummary(error) });
      core.recordExposure("capsule:error", 0, text.length);
      result(message.id, { content: [{ type: "text", text }], isError: true });
    }
    return;
  }

  protocolError(message.id, -32601, `Method not found: ${message.method}`);
}

let input = "";
let inputBytes = 0;
let discarding = false;
const pending = new Set();

function acceptLine(line) {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line);
    const work = Promise.resolve(handle(request)).catch(error => {
      protocolError(request?.id, -32603, `Internal error: ${errorSummary(error)}`);
    });
    pending.add(work);
    work.finally(() => pending.delete(work));
  } catch (error) {
    protocolError(null, -32700, `Parse error: ${errorSummary(error)}`);
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  let offset = 0;
  while (offset < chunk.length) {
    const newline = chunk.indexOf("\n", offset);
    const part = chunk.slice(offset, newline < 0 ? chunk.length : newline);
    if (!discarding) {
      inputBytes += Buffer.byteLength(part);
      if (inputBytes > MAX_MESSAGE_BYTES) {
        input = "";
        discarding = true;
        protocolError(null, -32600, "Request exceeds maximum message size");
      } else input += part;
    }
    if (newline < 0) break;
    if (!discarding) acceptLine(input);
    input = "";
    inputBytes = 0;
    discarding = false;
    offset = newline + 1;
  }
});

process.stdin.on("end", () => {
  if (!discarding) acceptLine(input);
  input = "";
  Promise.allSettled([...pending]).then(() => {
    unified.closeSearchDatabase();
    process.stdout.end();
  });
});
process.on("uncaughtException", (error) => {
  process.stderr.write(`capsule fatal: ${errorSummary(error)}\n`);
  process.exit(1);
});
