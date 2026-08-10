"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const state = fs.mkdtempSync(path.join(os.tmpdir(), "capsule-browser-bench-"));
process.env.CAPSULE_STATE = state;

const hook = require("../scripts/hook.cjs");
const core = require("../mcp/core.cjs");
const unified = require("../mcp/unified.cjs");

function replacement(result) {
  return String(
    result?.reason ||
    result?.hookSpecificOutput?.updatedMCPToolOutput ||
    result?.hookSpecificOutput?.additionalContext ||
    ""
  );
}

function exactText(text) {
  const id = text.match(/exact=(cap_[a-f0-9]{16})/i)?.[1];
  return id ? core.loadCapsule(id).text : "";
}

function textCase(name, toolName, output, needles) {
  const input = {
    tool_name: toolName,
    tool_input: { tab_id: name },
    tool_output: output,
    cwd: process.cwd(),
    session_id: `browser-ab-${name}`,
  };
  const treated = replacement(hook.handle("posttooluse", input));
  return {
    name,
    baseline_chars: output.length,
    treatment_chars: treated.length || output.length,
    saving_percent: Number(((output.length - (treated.length || output.length)) / output.length * 100).toFixed(2)),
    projected: /^\[Capsule browser-state /.test(treated),
    critical_evidence_preserved: needles.every((needle) => treated.includes(needle)),
    exact_recovery: exactText(treated) === output,
  };
}

function run() {
  const accessibility = [
    'url: "https://shop.example.test/cart"',
    'title: "Cart"',
    '- heading "Your cart" level=1',
    '- textbox "Search" ref=search focused=true',
    '- button "Checkout" ref=checkout disabled=false',
    '- dialog "Shipping warning" ref=warning',
    'network error: /inventory status=503 failed',
    ...Array.from({ length: 2_000 }, (_, index) =>
      `- generic "catalog row ${index}" description="merchandising metadata ${index}"`),
  ].join("\n");
  const dom = `<html><head><title>Account</title></head><body>` +
    "<div class=\"tile\">description</div>".repeat(4_000) +
    '<a href="/billing">Billing</a><button aria-label="Save changes">Save</button></body></html>';
  const network = [
    'url: "https://app.example.test/dashboard"',
    "request GET /api/profile status=200",
    ...Array.from({ length: 2_000 }, (_, index) =>
      `request GET /assets/chunk-${index}.js status=200 duration=${index % 17}ms`),
    "console error: websocket failed status=502",
  ].join("\n");
  const computerUse = [
    'tool: "computer-use.screenshot"',
    'window: "Checkout" url="https://shop.example.test/checkout"',
    'focused: "Card number"',
    'alert: "Payment declined" status=402',
    ...Array.from({ length: 2_000 }, (_, index) =>
      `pixel region ${index} bounds=0,${index},1280,${index + 1} confidence=0.${index % 10}`),
  ].join("\n");
  const cases = [
    textCase("accessibility", "chrome.browser_snapshot", accessibility, [
      "https://shop.example.test/cart", "Checkout", "focused=true", "status=503 failed",
    ]),
    textCase("minified-dom", "playwright.get_dom", dom, ["Billing", "Save"]),
    textCase("network-log", "browser.get_network_log", network, [
      "https://app.example.test/dashboard", "status=502",
    ]),
    textCase("computer-use", "Computer Use.screenshot", computerUse, [
      "https://shop.example.test/checkout", "Payment declined", "status=402",
    ]),
  ];

  const deltaSession = "browser-ab-delta";
  const stable = Array.from({ length: 800 }, (_, index) => `- link "Product ${index}" ref=p${index}`);
  const before = ['url: "https://example.test/products"', ...stable, '- button "Add" disabled=true'].join("\n");
  const after = ['url: "https://example.test/products"', ...stable, '- button "Add" disabled=false'].join("\n");
  const deltaBase = {
    tool_name: "browser.get_accessibility_tree",
    tool_input: { tab_id: "delta" },
    cwd: process.cwd(),
    session_id: deltaSession,
  };
  hook.handle("posttooluse", { ...deltaBase, tool_output: before });
  const delta = replacement(hook.handle("posttooluse", { ...deltaBase, tool_output: after }));
  const deltaCase = {
    name: "near-identical-state",
    baseline_chars: after.length,
    treatment_chars: delta.length,
    saving_percent: Number(((after.length - delta.length) / after.length * 100).toFixed(2)),
    projected: /^\[Capsule delta overlap=/.test(delta),
    critical_evidence_preserved: delta.includes("disabled=false"),
    exact_recovery: exactText(delta) === after,
  };
  cases.push(deltaCase);

  const screenshotSession = "browser-ab-screenshot";
  const screenshotBase = {
    tool_name: "chrome.capture_page",
    tool_input: { tab_id: "visual" },
    cwd: process.cwd(),
    session_id: screenshotSession,
  };
  const image = {
    caption: "checkout ready",
    content: [{
      type: "image",
      image_url: `data:image/png;base64,${Buffer.alloc(256 * 1024, 0x51).toString("base64")}`,
    }],
  };
  const changedImage = {
    caption: "checkout blocked",
    content: [{
      type: "image",
      image_url: `data:image/png;base64,${Buffer.alloc(256 * 1024, 0x52).toString("base64")}`,
    }],
  };
  const first = hook.handle("posttooluse", { ...screenshotBase, tool_output: image });
  const duplicate = replacement(hook.handle("posttooluse", { ...screenshotBase, tool_output: image }));
  const changed = replacement(hook.handle("posttooluse", { ...screenshotBase, tool_output: changedImage }));
  const imageChars = JSON.stringify(image).length;
  cases.push({
    name: "exact-screenshot-replay",
    baseline_chars: imageChars,
    treatment_chars: duplicate.length,
    saving_percent: Number(((imageChars - duplicate.length) / imageChars * 100).toFixed(2)),
    projected: /exact duplicate/i.test(duplicate),
    critical_evidence_preserved: replacement(first) === "" && changed === "",
    exact_recovery: true,
  });

  const baselineTotal = cases.reduce((sum, item) => sum + item.baseline_chars, 0);
  const treatmentTotal = cases.reduce((sum, item) => sum + item.treatment_chars, 0);
  const result = {
    method: {
      scope: "Deterministic PostToolUse characters for Chrome/browser accessibility, DOM, network, delta and screenshot tasks.",
      baseline: "Raw tool payload visible to the model.",
      treatment: "Capsule browser-state projection, exact delta, or byte-identical media replay.",
      exclusion: "Character reduction is not provider billing, image-token, latency, or cache-hit measurement.",
    },
    summary: {
      cases: cases.length,
      baseline_chars: baselineTotal,
      treatment_chars: treatmentTotal,
      weighted_saving_percent: Number(((baselineTotal - treatmentTotal) / baselineTotal * 100).toFixed(2)),
      safety_pass: cases.every((item) =>
        item.projected && item.critical_evidence_preserved && item.exact_recovery),
    },
    cases,
  };
  return result;
}

try {
  const result = run();
  const writeIndex = process.argv.indexOf("--write");
  if (writeIndex >= 0 && process.argv[writeIndex + 1]) {
    fs.writeFileSync(path.resolve(process.argv[writeIndex + 1]), `${JSON.stringify(result, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.summary.safety_pass) process.exitCode = 1;
} finally {
  unified.closeSearchDatabase();
  fs.rmSync(state, { recursive: true, force: true });
}
