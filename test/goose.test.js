// goose adapter tests. Everything writes into a throwaway plugin root.
//
// Spec these assert against: https://goose-docs.ai/blog/2026/05/14/goose-hooks/
// (read 2026-07-30). If goose changes the spec these should fail loudly rather than
// silently writing a config goose ignores.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-goose-test-"));
process.env.FOREMAN_HOME = path.join(sandbox, "home");
process.env.FOREMAN_CLAUDE_SETTINGS = path.join(sandbox, "claude", "settings.json");
process.env.FOREMAN_GOOSE_PLUGINS = path.join(sandbox, "agents", "plugins");

const goose = await import("../src/adapters/goose.js");
const { stateForHook, normalizeHook, toolKind } = await import("../src/state.js");
const { STATES } = await import("../src/engine.js");
const { getAdapter, ADAPTERS } = await import("../src/index.js");

// ── the file lands where the spec says ──────────────────────────────────────
test("the plugin goes to ~/.agents/plugins/foreman/hooks/hooks.json", () => {
  const f = goose.hooksFile();
  assert.equal(path.basename(f), "hooks.json");
  assert.equal(path.basename(path.dirname(f)), "hooks");
  assert.equal(path.basename(path.dirname(path.dirname(f))), "foreman");
});

test("install writes the structure goose documents", () => {
  const r = goose.install({ bin: "foreman" });
  assert.ok(fs.existsSync(r.file));
  const cfg = JSON.parse(fs.readFileSync(r.file, "utf8"));

  assert.ok(cfg.hooks, "top-level 'hooks' key required");
  for (const evt of goose.HOOK_EVENTS) {
    const groups = cfg.hooks[evt];
    assert.ok(Array.isArray(groups), `${evt} must be an array`);
    const h = groups[0].hooks[0];
    assert.equal(h.type, "command");
    assert.equal(h.command, "foreman hook");
  }
});

test("install is idempotent and backs up an existing file", () => {
  const first = goose.install({ bin: "foreman" });
  const before = fs.readFileSync(first.file, "utf8");
  const second = goose.install({ bin: "foreman" });
  assert.equal(fs.readFileSync(second.file, "utf8"), before, "content drifted on re-install");
  assert.ok(second.backup, "an existing file must be backed up");
  assert.equal(second.created, false);
});

test("a dry run writes nothing", () => {
  const dir = fs.mkdtempSync(path.join(sandbox, "dry-"));
  process.env.FOREMAN_GOOSE_PLUGINS = dir;
  const r = goose.install({ dryRun: true });
  assert.ok(!fs.existsSync(r.file));
  assert.ok(r.dryRun);
  process.env.FOREMAN_GOOSE_PLUGINS = path.join(sandbox, "agents", "plugins");
});

test("install states the cost limitation rather than hiding it", () => {
  const r = goose.install({ bin: "foreman" });
  assert.ok(r.warnings.some((w) => /cost and context/i.test(w)), "must warn that cost is unavailable");
  assert.equal(goose.PROVIDES_COST, false);
});

test("status reports what is wired", () => {
  goose.install({ bin: "foreman" });
  const s = goose.status();
  assert.ok(s.exists);
  assert.deepEqual(s.missing, []);
  assert.equal(s.events.length, goose.HOOK_EVENTS.length);
  assert.equal(s.providesCost, false);
});

test("uninstall removes only our plugin directory", () => {
  const root = fs.mkdtempSync(path.join(sandbox, "root-"));
  process.env.FOREMAN_GOOSE_PLUGINS = root;
  const neighbour = path.join(root, "someone-else", "hooks");
  fs.mkdirSync(neighbour, { recursive: true });
  fs.writeFileSync(path.join(neighbour, "hooks.json"), "{}");

  goose.install({ bin: "foreman" });
  const r = goose.uninstall();
  assert.ok(r.removed);
  assert.ok(!fs.existsSync(goose.pluginDir()), "our plugin should be gone");
  assert.ok(fs.existsSync(path.join(neighbour, "hooks.json")), "another plugin was deleted");

  const again = goose.uninstall();
  assert.equal(again.removed, false, "uninstalling twice must be safe");
  process.env.FOREMAN_GOOSE_PLUGINS = path.join(sandbox, "agents", "plugins");
});

// ── goose's payload shape ───────────────────────────────────────────────────
test("normalizeHook reads goose's 'event' and Claude Code's 'hook_event_name'", () => {
  assert.equal(normalizeHook({ event: "PreToolUse" }).event, "PreToolUse");
  assert.equal(normalizeHook({ hook_event_name: "PreToolUse" }).event, "PreToolUse");
  assert.equal(normalizeHook({}).event, null);
});

test("toolKind strips goose's extension namespace", () => {
  assert.equal(toolKind("developer__shell"), "shell");
  assert.equal(toolKind("Bash"), "shell");
  assert.equal(toolKind("Grep"), "search");
  assert.equal(toolKind("developer__unknown_thing"), null);
});

test("goose's text_editor reads or writes depending on its command", () => {
  // one tool name, two very different activities — the mascot must not show 'writing'
  // while the agent is only looking
  assert.equal(toolKind("developer__text_editor", { command: "view" }), "read");
  assert.equal(toolKind("developer__text_editor", { command: "write" }), "edit");
  assert.equal(toolKind("developer__text_editor", { command: "str_replace" }), "edit");
});

test("a goose payload maps to the same states as the Claude Code equivalent", () => {
  const g = (event, tool_name, tool_input) => stateForHook({ event, tool_name, tool_input, session_id: "x", working_dir: "/w" });
  assert.equal(g("SessionStart"), "wake");
  assert.equal(g("UserPromptSubmit"), "think");
  assert.equal(g("PreToolUse", "developer__shell"), "hammer");
  assert.equal(g("PreToolUse", "developer__text_editor", { command: "view" }), "read");
  assert.equal(g("PreToolUse", "developer__text_editor", { command: "write" }), "type");
  assert.equal(g("BeforeShellExecution"), "hammer");
  assert.equal(g("BeforeReadFile"), "read");
  assert.equal(g("AfterFileEdit"), "type");
  assert.equal(g("SessionEnd"), "flag");
  assert.equal(g("Stop"), "flag");
});

test("goose reports tool failure explicitly instead of us inferring it", () => {
  assert.equal(stateForHook({ event: "PostToolUseFailure", tool_name: "developer__shell" }), "stumble");
  assert.equal(stateForHook({ event: "PostToolUse", tool_name: "developer__shell" }), null);
  assert.equal(stateForHook({ event: "AfterShellExecution" }), null);
});

test("every state either adapter can produce exists in the engine", () => {
  const payloads = [
    ...goose.HOOK_EVENTS.map((event) => ({ event, tool_name: "developer__shell" })),
    ...goose.HOOK_EVENTS.map((event) => ({ event, tool_name: "developer__text_editor", tool_input: { command: "view" } })),
    { hook_event_name: "PreToolUse", tool_name: "Bash" },
    { hook_event_name: "PostToolUse", tool_response: { error: "x" } },
  ];
  for (const p of payloads) {
    const s = stateForHook(p);
    if (s !== null) assert.ok(STATES[s], `'${s}' is not a real state (from ${p.event ?? p.hook_event_name})`);
  }
});

test("Claude Code behaviour is unchanged by adding goose", () => {
  assert.equal(stateForHook({ hook_event_name: "Notification" }), "ping");
  assert.equal(stateForHook({ hook_event_name: "PreCompact" }), "stopSign");
  assert.equal(stateForHook({ hook_event_name: "SubagentStop" }), "flag");
  assert.equal(stateForHook({ hook_event_name: "PreToolUse", tool_name: "Agent" }), "summon");
  assert.equal(stateForHook({ hook_event_name: "PreToolUse", tool_name: "WhoKnows" }), "think");
  assert.equal(stateForHook({ hook_event_name: "Nonsense" }), null);
});

test("goose is registered as an adapter", async () => {
  assert.ok(ADAPTERS.includes("goose"));
  const a = await getAdapter("goose");
  assert.equal(a.id, "goose");
  await assert.rejects(() => getAdapter("emacs"), /unknown adapter/);
});
