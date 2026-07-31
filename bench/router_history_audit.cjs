#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

function integerFlag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function stringFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? String(process.argv[index + 1]) : "";
}

function sessionFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const directory = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) stack.push(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push({ path: target, mtime_ms: fs.statSync(target).mtimeMs });
      }
    }
  }
  return files.sort((left, right) => right.mtime_ms - left.mtime_ms);
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b([a-z]{4,})s\b/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function suspiciousReason(query, match) {
  if (!match) return "";
  const name = normalize(match.name);
  const normalizedQuery = normalize(query);
  if (name.startsWith("artifact template ")) {
    const title = name.replace(/^artifact template /, "");
    if (!normalizedQuery.includes(title)) return "artifact-template-without-explicit-title";
  }
  if (name === "improve codebase architecture" &&
      !/\b(?:codebase|repository|repo|module|refactor|source tree)\b/.test(normalizedQuery)) {
    return "codebase-architecture-without-codebase-intent";
  }
  if (name === "thick client" &&
      !/\b(?:desktop|thick client|electron|qt|winforms|wpf|native app|installed app|local app|exe)\b/.test(normalizedQuery)) {
    return "thick-client-without-desktop-intent";
  }
  if (/\b(?:gmail|outlook|email|inbox|mailbox)\b/.test(name) &&
      !/\b(?:gmail|outlook|e mail|email|inbox|mailbox|mail|message|thread|reply|forward)\b/.test(normalizedQuery)) {
    return "email-skill-without-email-intent";
  }
  return "";
}

function parseRouteEvent(record, source) {
  if (record?.type !== "event_msg" || record.payload?.type !== "mcp_tool_call_end") return null;
  const invocation = record.payload.invocation || {};
  const args = invocation.arguments || {};
  if (!["capsule", "capsule"].includes(invocation.server) || invocation.tool !== "capsule" ||
      args.action !== "skills" || args.payload?.operation !== "route") return null;
  const text = record.payload.result?.Ok?.content?.find((item) => item.type === "text")?.text || "";
  let response;
  try {
    response = JSON.parse(text);
  } catch {
    response = { error: "unparseable route result" };
  }
  const query = String(args.payload.query || "");
  const match = Array.isArray(response.matches) ? response.matches[0] : null;
  return {
    timestamp: record.timestamp || "",
    source: path.basename(source),
    query,
    match: match ? match.name : null,
    score: match ? Number(match.score || 0) : null,
    error: response.error || null,
    suspicious: suspiciousReason(query, match) || null,
  };
}

async function eventsFromFile(file) {
  const events = [];
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const event = parseRouteEvent(record, file);
    if (event) events.push(event);
  }
  return events;
}

async function main() {
  const fileLimit = integerFlag("--files", 30);
  const eventLimit = integerFlag("--events", 100);
  const root = path.resolve(
    process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    "sessions"
  );
  const explicitFile = stringFlag("--file");
  const files = explicitFile
    ? [{ path: path.resolve(explicitFile), mtime_ms: fs.statSync(path.resolve(explicitFile)).mtimeMs }]
    : sessionFiles(root).slice(0, fileLimit);
  const events = [];
  for (const file of files) events.push(...await eventsFromFile(file.path));
  events.sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)));
  const selected = events.slice(0, eventLimit);
  const bySkill = {};
  for (const event of selected) {
    const key = event.error ? "(error)" : event.match || "(no-match)";
    bySkill[key] = (bySkill[key] || 0) + 1;
  }
  const output = {
    root,
    files_scanned: files.length,
    route_events: selected.length,
    matched: selected.filter((event) => event.match).length,
    no_match: selected.filter((event) => !event.match && !event.error).length,
    errors: selected.filter((event) => event.error).length,
    suspicious: selected.filter((event) => event.suspicious).length,
    by_skill: Object.fromEntries(
      Object.entries(bySkill).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    ),
    suspicious_events: selected.filter((event) => event.suspicious),
    events: selected,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`router history audit failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
