"use strict";

const actions = [
  "run", "batch", "flow", "file", "project", "index", "search", "remember", "fetch",
  "execute", "cognition", "jobs", "interrupt", "rewrite", "filters", "gain", "discover", "learn", "telemetry",
  "pipe", "insight", "advisor", "skills", "purge", "expand", "diff", "list", "stats", "doctor",
  "command", "ledger",
];

const tools = [
  {
    name: "capsule",
    description: "Exact context. Common: advisor,skills,project,run,batch,file,search,fetch,expand,discover.",
    inputSchema: {
      type: "object",
      required: ["action"],
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          minLength: 1,
          maxLength: 32,
        },
        payload: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
  },
];

// Array properties are not serialized by JSON.stringify, so the complete
// catalog stays available to local validation without entering tools/list.
tools.actions = actions;
tools.instructions = "Start advisor.plan; skills via action=skills,payload.operation=route; batch; project=code; flow=batch; expand/diff use capsule_id.";
module.exports = tools;
