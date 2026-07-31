"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const core = require("../mcp/core.cjs");

const EVENTS = [
  ["PreToolUse", "pretooluse", "local_shell|shell|shell_command|exec_command|terminal|Bash|Shell|sh|zsh|fish|powershell|pwsh|cmd|write_stdin|apply_patch|Edit|Write|grep_files|mcp__|spawn_agent|collaboration|read_thread|codex_app"],
  ["PostToolUse", "posttooluse", ""],
  ["SessionStart", "sessionstart", ""],
  ["PreCompact", "precompact", ""],
  ["UserPromptSubmit", "userpromptsubmit", ""],
  ["Stop", "stop", ""],
];

function paths() {
  const root = process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), ".codex");
  return {
    target: path.join(root, "hooks.json"),
    backup: path.join(root, "hooks.pre-capsule.json"),
    launcher: path.join(root, "capsule-hook.cjs"),
    pointer: path.join(root, "capsule-hook-target.json"),
  };
}

function commandFor(event) {
  return `"${process.execPath}" --no-warnings "${paths().launcher}" ${event}`;
}

function pluginHooksFeature() {
  const override = process.env.CAPSULE_HOOKS_FEATURE ||
    process.env.CAPSULE_PLUGIN_HOOKS_FEATURE;
  if (override === "0" || override === "1") {
    return {
      detected: true,
      enabled: override === "1",
      lifecycle: "override",
      name: "hooks",
      source: process.env.CAPSULE_HOOKS_FEATURE
        ? "CAPSULE_HOOKS_FEATURE"
        : "CAPSULE_PLUGIN_HOOKS_FEATURE",
    };
  }
  try {
    const result = spawnSync("codex", ["features", "list"], {
      encoding: "utf8",
      shell: process.platform === "win32",
      windowsHide: true,
      timeout: 5000,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    const match = output.match(/^hooks\s+(\S+)\s+(true|false)\s*$/mi) ||
      output.match(/^plugin_hooks\s+(\S+)\s+(true|false)\s*$/mi);
    if (match) {
      return {
        detected: true,
        enabled: match[2].toLowerCase() === "true",
        lifecycle: match[1],
        name: /^hooks\s/im.test(match[0]) ? "hooks" : "plugin_hooks",
        source: "codex features list",
      };
    }
  } catch {
    // Older builds may not expose the feature table. Preserve their bundled-hook behavior.
  }
  return {
    detected: false,
    enabled: true,
    lifecycle: "unknown",
    name: "hooks",
    source: "conservative default",
  };
}

function readHooks(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed.hooks || typeof parsed.hooks !== "object") parsed.hooks = {};
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return { hooks: {} };
    throw error;
  }
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

function writeTextAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, value, "utf8");
  fs.renameSync(temporary, file);
}

function installLauncher(state) {
  const source = [
    '"use strict";',
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const pointer = JSON.parse(fs.readFileSync(path.join(__dirname, "capsule-hook-target.json"), "utf8"));',
    'const script = path.resolve(String(pointer.script || ""));',
    'if (!script || !fs.existsSync(script)) throw new Error(`Capsule hook target missing: ${script}`);',
    'const hook = require(script);',
    'if (typeof hook.main !== "function") throw new Error(`Capsule hook target has no main(): ${script}`);',
    'hook.main();',
    "",
  ].join("\n");
  if (!fs.existsSync(state.launcher) || fs.readFileSync(state.launcher, "utf8") !== source) {
    writeTextAtomic(state.launcher, source);
  }
  writeAtomic(state.pointer, {
    script: path.join(__dirname, "hook.cjs"),
    updated_at: new Date().toISOString(),
  });
}

function clean(entries) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    ...entry,
    hooks: (entry.hooks || []).filter((hook) =>
      !/capsule[\\/].*hook\.cjs|scripts[\\/]hook\.cjs|capsule-hook\.cjs/i.test(String(hook.command || ""))
    ),
  })).filter((entry) => entry.hooks.length);
}

function install() {
  const state = paths();
  const hooks = readHooks(state.target);
  const feature = pluginHooksFeature();
  if (fs.existsSync(state.target) && !fs.existsSync(state.backup)) fs.copyFileSync(state.target, state.backup);
  installLauncher(state);
  for (const [name, event, matcher] of EVENTS) {
    hooks.hooks[name] = clean(hooks.hooks[name]);
    if (!feature.enabled) {
      hooks.hooks[name].push({
        matcher,
        hooks: [{ type: "command", command: commandFor(event) }],
      });
    }
    if (!hooks.hooks[name].length) delete hooks.hooks[name];
  }
  writeAtomic(state.target, hooks);
  return {
    operation: "install",
    target: state.target,
    backup: state.backup,
    launcher: state.launcher,
    pointer: state.pointer,
    events: EVENTS.length,
    mode: feature.enabled ? "plugin-bundled-native" : "global-fallback",
    plugin_hooks_feature: feature,
  };
}

function removeGlobal() {
  const state = paths();
  const hooks = readHooks(state.target);
  let removed = 0;
  for (const [name] of EVENTS) {
    const before = Array.isArray(hooks.hooks[name]) ? hooks.hooks[name].length : 0;
    const kept = clean(hooks.hooks[name]);
    removed += before - kept.length;
    if (kept.length) hooks.hooks[name] = kept;
    else delete hooks.hooks[name];
  }
  writeAtomic(state.target, hooks);
  return {
    operation: "remove-global",
    target: state.target,
    removed_entries: removed,
    plugin_bundle_preserved: fs.existsSync(path.join(__dirname, "..", "hooks", "hooks.json")),
  };
}

function restore() {
  const state = paths();
  if (!fs.existsSync(state.backup)) throw new Error(`backup not found: ${state.backup}`);
  fs.copyFileSync(state.backup, state.target);
  return { operation: "restore", target: state.target, backup: state.backup };
}

function status() {
  const state = paths();
  const hooks = readHooks(state.target);
  let bundled = { hooks: {} };
  try {
    bundled = readHooks(path.join(__dirname, "..", "hooks", "hooks.json"));
  } catch {
    bundled = { hooks: {} };
  }
  const globalEvents = {};
  const bundledEvents = {};
  const configuredEvents = {};
  const observedEvents = {};
  const heartbeatAgeMs = {};
  const events = {};
  const feature = pluginHooksFeature();
  let pointerScript = "";
  try {
    pointerScript = path.resolve(JSON.parse(fs.readFileSync(state.pointer, "utf8")).script || "");
  } catch {
    pointerScript = "";
  }
  const localState = core.stateRoot();
  for (const [name, event] of EVENTS) {
    const commands = (hooks.hooks[name] || []).flatMap((entry) =>
      (entry.hooks || []).map((hook) => String(hook.command || ""))
    );
    const bundledCommands = (bundled.hooks[name] || []).flatMap((entry) =>
      (entry.hooks || []).map((hook) => String(hook.command || ""))
    );
    const hasStableLauncher = commands.some((command) => /capsule-hook\.cjs/i.test(command));
    globalEvents[name] = commands.some((command) =>
      /capsule[\\/].*scripts[\\/]hook\.cjs|capsule-hook\.cjs/i.test(command)
    );
    bundledEvents[name] = bundledCommands.some((command) =>
      /scripts[\\/]hook\.cjs/i.test(command)
    );
    configuredEvents[name] = globalEvents[name] || (feature.enabled && bundledEvents[name]);
    const configuredCommands = [
      ...commands,
      ...(feature.enabled ? bundledCommands : []),
      ...(hasStableLauncher && pointerScript ? [pointerScript] : []),
    ];
    try {
      const heartbeat = JSON.parse(fs.readFileSync(
        path.join(localState, "hooks", `heartbeat-${event}.json`),
        "utf8"
      ));
      const age = Math.max(0, Date.now() - Date.parse(heartbeat.at));
      const script = path.normalize(String(heartbeat.script || "")).toLowerCase();
      const bundledHeartbeat = feature.enabled && bundledEvents[name] &&
        /capsule[\\/].*scripts[\\/]hook\.cjs/i.test(script);
      heartbeatAgeMs[name] = age;
      observedEvents[name] = Number.isFinite(age) && age <= 24 * 60 * 60 * 1000 &&
        (bundledHeartbeat || configuredCommands.some((command) =>
          path.normalize(command).toLowerCase().includes(script)
        ));
    } catch {
      observedEvents[name] = false;
      heartbeatAgeMs[name] = null;
    }
    events[name] = configuredEvents[name] && observedEvents[name];
  }
  const duplicateSources = EVENTS.filter(([name]) =>
    feature.enabled && globalEvents[name] && bundledEvents[name]
  )
    .map(([name]) => name);
  return {
    operation: "status",
    target: state.target,
    backup: fs.existsSync(state.backup),
    events,
    configured_events: configuredEvents,
    observed_events: observedEvents,
    heartbeat_age_ms: heartbeatAgeMs,
    sources: {
      plugin_bundled: bundledEvents,
      global_fallback: globalEvents,
    },
    plugin_hooks_feature: feature,
    duplicate_event_sources: duplicateSources,
    stable_launcher: {
      path: state.launcher,
      pointer: state.pointer,
      target: pointerScript,
      ready: fs.existsSync(state.launcher) && Boolean(pointerScript) && fs.existsSync(pointerScript),
    },
  };
}

function main() {
  const operation = process.argv[2] || "status";
  const result = operation === "install"
    ? install()
    : operation === "restore"
    ? restore()
    : ["remove", "uninstall", "remove-global"].includes(operation)
    ? removeGlobal()
    : status();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) main();

module.exports = { commandFor, install, paths, pluginHooksFeature, removeGlobal, restore, status };
