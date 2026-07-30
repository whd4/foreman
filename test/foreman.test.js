// Tests run against a throwaway FOREMAN_HOME and a fixture settings file, so they
// never touch the real ~/.foreman or ~/.claude/settings.json.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-test-"));
process.env.FOREMAN_HOME = path.join(sandbox, "home");
process.env.FOREMAN_CLAUDE_SETTINGS = path.join(sandbox, "claude", "settings.json");
fs.mkdirSync(path.dirname(process.env.FOREMAN_CLAUDE_SETTINGS), { recursive: true });

const { validate, load, list, REQUIRED_POSES, REQUIRED_PROPS } = await import("../src/character.js");
const { Frame } = await import("../src/render.js");
const { createEngine, STATES, stateNames } = await import("../src/engine.js");
const { parsePayload, formatLine } = await import("../src/statusline.js");
const store = await import("../src/state.js");
const claude = await import("../src/adapters/claude-code.js");

// ── characters ───────────────────────────────────────────────────────────
test("the bundled crab pack is valid", () => {
  const crab = load("crab");
  assert.equal(crab.name, "crab");
  const v = validate(crab);
  assert.deepEqual(v.errors, []);
  assert.ok(v.ok);
});

test("crab defines every required pose and prop", () => {
  const crab = load("crab");
  for (const p of REQUIRED_POSES) assert.ok(crab.poses[p], `missing pose ${p}`);
  for (const p of REQUIRED_PROPS) assert.ok(crab.props[p], `missing prop ${p}`);
});

test("every pose shares one footprint", () => {
  const crab = load("crab");
  const [w, h] = crab.size;
  for (const [name, grid] of Object.entries(crab.poses)) {
    assert.equal(grid.length, h, `${name} height`);
    for (const [i, row] of grid.entries()) assert.equal(row.length, w, `${name} row ${i} width`);
  }
});

test("validate rejects a ragged grid", () => {
  const v = validate({
    name: "bad", palette: { o: "#FFFFFF" },
    poses: { stand: ["oo", "ooo"], stepA: ["oo"], stepB: ["oo"], crouch: ["oo"], slump: ["oo"] },
    props: { flag: { grid: ["o"] }, stop: { grid: ["o"] }, crate: { grid: ["o"] }, coin: { grid: ["o"] } },
  });
  assert.ok(!v.ok);
  assert.ok(v.errors.some((e) => /same width/.test(e)));
});

test("validate rejects a colour with no palette entry", () => {
  const v = validate({
    name: "bad", palette: { o: "#FFFFFF" },
    poses: { stand: ["oz"], stepA: ["oo"], stepB: ["oo"], crouch: ["oo"], slump: ["oo"] },
    props: { flag: { grid: ["o"] }, stop: { grid: ["o"] }, crate: { grid: ["o"] }, coin: { grid: ["o"] } },
  });
  assert.ok(!v.ok);
  assert.ok(v.errors.some((e) => /'z' has no palette entry/.test(e)));
});

test("validate rejects a non-hex colour", () => {
  const v = validate({ name: "x", palette: { o: "red" }, poses: {}, props: {} });
  assert.ok(v.errors.some((e) => /not a #rrggbb/.test(e)));
});

test("list reports the bundled pack as healthy", () => {
  const found = list().find((c) => c.name === "crab");
  assert.ok(found);
  assert.equal(found.ok, true);
});

// ── renderer ─────────────────────────────────────────────────────────────
test("Frame forces an even height so half-blocks pair up", () => {
  assert.equal(new Frame(10, 7).h, 8);
  assert.equal(new Frame(10, 8).h, 8);
});

test("Frame ignores out-of-bounds writes instead of throwing", () => {
  const f = new Frame(4, 4);
  f.set(-1, 0, "#ffffff"); f.set(0, 99, "#ffffff"); f.set(4, 4, "#ffffff");
  assert.equal(f.px.filter(Boolean).length, 0);
});

test("one row of pixels renders as half-blocks, one line per two rows", () => {
  const f = new Frame(3, 4);
  f.set(0, 0, "#ffffff");
  const lines = f.toLines({ color: false });
  assert.equal(lines.length, 2);
  assert.equal(lines[0][0], "#");
  assert.equal(lines[1].trim(), "");
});

test("blit honours flip", () => {
  const f = new Frame(3, 2);
  f.blit(["o.."], { o: "#ffffff" }, 0, 0, { flip: true });
  assert.equal(f.get(2, 0), "#ffffff");
  assert.equal(f.get(0, 0), null);
});

test("colour output never leaves a colour open, so it cannot bleed into the prompt", () => {
  // The invariant is not "ends with a reset" — a trailing blank cell emits the reset and
  // then a space. It's that the LAST escape sequence on the line is always the reset.
  const patterns = [
    [[0, 0]],                                  // colour then blank
    [[1, 1]],                                  // blank then colour, bottom half
    [[0, 0], [1, 0], [0, 1], [1, 1]],          // fully filled
    [[1, 0]],                                  // ends coloured
  ];
  for (const pts of patterns) {
    const f = new Frame(2, 2);
    for (const [x, y] of pts) f.set(x, y, "#e8825a");
    for (const line of f.toLines({ color: true })) {
      const codes = line.match(/\x1b\[[0-9;]*m/g);
      if (!codes) continue;                     // an all-blank row emits nothing
      assert.equal(codes.at(-1), "\x1b[0m", `colour left open in: ${JSON.stringify(line)}`);
    }
  }
});

// ── engine ───────────────────────────────────────────────────────────────
test("every state renders without throwing, for the bundled pack", () => {
  const crab = load("crab");
  const eng = createEngine(crab, { width: 40, height: 14, hud: { ctxPct: 40, costUsd: 1, burn: 0.5 } });
  for (const name of stateNames()) {
    eng.setState(name, 0);
    for (const t of [0, 120, 600, 1400, 3000]) {
      const lines = eng.render(t, { color: false });
      assert.equal(lines.length, 7, `${name} produced the wrong row count`);
    }
  }
});

test("every state draws at least one pixel at some point", () => {
  const crab = load("crab");
  const eng = createEngine(crab, { width: 40, height: 14, hud: {} });
  for (const name of stateNames()) {
    let lit = false;
    for (const t of [0, 200, 500, 900, 1500, 2400]) {
      eng.setState(name, 0);
      if (eng.render(t, { color: false }).join("").includes("#")) { lit = true; break; }
    }
    assert.ok(lit, `state '${name}' never drew anything`);
  }
});

test("setState rejects an unknown state", () => {
  const eng = createEngine(load("crab"));
  assert.throws(() => eng.setState("nope"), /unknown state/);
});

test("context pressure overrides the current state", () => {
  const hud = { ctxPct: 92 };
  const eng = createEngine(load("crab"), { width: 30, height: 12, hud });
  eng.setState("idle", 0);
  eng.render(10, { autoFromHud: true, color: false });
  assert.equal(eng.state, "stopSign");
});

test("a finite state falls back to idle once it elapses", () => {
  const eng = createEngine(load("crab"), { width: 30, height: 12 });
  eng.setState("wake", 0);
  eng.render(50, { color: false });
  assert.equal(eng.state, "wake");
  eng.render(99999, { color: false });
  assert.equal(eng.state, "idle");
});

// ── status line ──────────────────────────────────────────────────────────
test("parsePayload reads the verified field names", () => {
  const h = parsePayload({
    context_window: { context_window_size: 200000, current_usage: 142000, used_percentage: 71 },
    session: { total_cost_usd: 3.8421, total_lines_added: 412, total_lines_removed: 57 },
    model: { display_name: "Opus 5" }, subscription_type: "max",
    workspace: { current_dir: "/home/w/proj" },
  });
  assert.equal(h.ctxPct, 71);
  assert.equal(h.costUsd, 3.8421);
  assert.equal(h.linesAdded, 412);
  assert.equal(h.model, "Opus 5");
  assert.equal(h.plan, "max");
  assert.equal(h.dir, "proj");
});

test("parsePayload derives used% from remaining% when only that is present", () => {
  assert.equal(parsePayload({ context_window: { remaining_percentage: 29 } }).ctxPct, 71);
});

test("parsePayload survives an empty or junk payload", () => {
  for (const p of [null, undefined, {}, { session: null }, { context_window: "x" }]) {
    const h = parsePayload(p);
    assert.equal(h.ctxPct, 0);
    assert.equal(h.costUsd, 0);
    assert.ok(typeof h.model === "string");
  }
});

test("the status line warns once context is critical", () => {
  const line = formatLine(parsePayload({ context_window: { used_percentage: 91 }, session: { total_cost_usd: 12.07 } }));
  assert.match(line, /STOP: start a new window/);
  assert.match(line, /\$12\.07/);
});

test("the status line stays quiet below the threshold", () => {
  const line = formatLine(parsePayload({ context_window: { used_percentage: 40 } }));
  assert.ok(!line.includes("STOP"));
});

// ── hook mapping ─────────────────────────────────────────────────────────
test("hook events map to the intended states", () => {
  const cases = [
    [{ hook_event_name: "SessionStart" }, "wake"],
    [{ hook_event_name: "PreCompact" }, "stopSign"],
    [{ hook_event_name: "Stop" }, "flag"],
    [{ hook_event_name: "PreToolUse", tool_name: "Read" }, "read"],
    [{ hook_event_name: "PreToolUse", tool_name: "Grep" }, "dig"],
    [{ hook_event_name: "PreToolUse", tool_name: "Edit" }, "type"],
    [{ hook_event_name: "PreToolUse", tool_name: "Bash" }, "hammer"],
    [{ hook_event_name: "PreToolUse", tool_name: "Agent" }, "summon"],
  ];
  for (const [payload, want] of cases) assert.equal(store.stateForHook(payload), want, JSON.stringify(payload));
});

test("a successful PostToolUse is ignored; a failure stumbles", () => {
  assert.equal(store.stateForHook({ hook_event_name: "PostToolUse", tool_response: {} }), null);
  assert.equal(store.stateForHook({ hook_event_name: "PostToolUse", tool_response: { stderr: "boom" } }), "stumble");
  assert.equal(store.stateForHook({ hook_event_name: "PostToolUse", tool_response: { success: false } }), "stumble");
});

test("unknown events map to nothing rather than guessing", () => {
  assert.equal(store.stateForHook({ hook_event_name: "SomethingNew" }), null);
  assert.equal(store.stateForHook(null), null);
});

test("every state a hook can produce actually exists in the engine", () => {
  const payloads = [
    { hook_event_name: "SessionStart" }, { hook_event_name: "UserPromptSubmit" },
    { hook_event_name: "Notification" }, { hook_event_name: "PreCompact" },
    { hook_event_name: "SubagentStop" }, { hook_event_name: "Stop" },
    { hook_event_name: "PostToolUse", tool_response: { error: "x" } },
    ...["Read", "Grep", "Glob", "Write", "Edit", "Bash", "Agent", "Whatever"]
      .map((t) => ({ hook_event_name: "PreToolUse", tool_name: t })),
  ];
  for (const p of payloads) {
    const s = store.stateForHook(p);
    if (s) assert.ok(STATES[s], `hook produced '${s}' which the engine does not define`);
  }
});

// ── state store ──────────────────────────────────────────────────────────
test("emit increments seq so readers can detect a change", () => {
  const a = store.emit("dig");
  const b = store.emit("type");
  assert.equal(b.seq, a.seq + 1);
  assert.equal(store.readState().state, "type");
});

test("writeHud infers a burn rate from the cost delta", () => {
  store.writeHud({ ctxPct: 10, costUsd: 1.0 });
  const second = store.writeHud({ ctxPct: 12, costUsd: 1.5 });
  assert.ok(second.burn > 0, "expected a positive burn rate after cost increased");
});

test("config round-trips", () => {
  store.setConfig({ character: "crab" });
  assert.equal(store.getConfig().character, "crab");
});

// ── claude code adapter ──────────────────────────────────────────────────
test("install is idempotent and does not duplicate hooks", () => {
  fs.writeFileSync(process.env.FOREMAN_CLAUDE_SETTINGS, "{}");
  const first = claude.install({ bin: "foreman" });
  assert.ok(first.added.length > 0);

  const second = claude.install({ bin: "foreman" });
  assert.deepEqual(second.added, [], "second install should add nothing");

  const s = JSON.parse(fs.readFileSync(process.env.FOREMAN_CLAUDE_SETTINGS, "utf8"));
  for (const evt of claude.HOOK_EVENTS) {
    const ours = s.hooks[evt].filter((g) => g.hooks.some((h) => h.command.includes("foreman")));
    assert.equal(ours.length, 1, `${evt} has ${ours.length} foreman entries`);
  }
});

test("install preserves hooks that were already there", () => {
  fs.writeFileSync(process.env.FOREMAN_CLAUDE_SETTINGS, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "my-own-script" }] }] },
    env: { KEEP_ME: "1" },
  }));
  claude.install({ bin: "foreman" });
  const s = JSON.parse(fs.readFileSync(process.env.FOREMAN_CLAUDE_SETTINGS, "utf8"));
  const cmds = s.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(cmds.includes("my-own-script"), "existing hook was dropped");
  assert.ok(cmds.some((c) => c.includes("foreman")));
  assert.equal(s.env.KEEP_ME, "1", "unrelated settings were dropped");
});

test("install refuses to clobber a foreign status line without --force", () => {
  fs.writeFileSync(process.env.FOREMAN_CLAUDE_SETTINGS, JSON.stringify({
    statusLine: { type: "command", command: "someone-elses-statusline" },
  }));
  const r = claude.install({ bin: "foreman" });
  assert.equal(r.statusLine, "kept");
  assert.ok(r.warnings.some((w) => /already have a statusLine/.test(w)));
  const s = JSON.parse(fs.readFileSync(process.env.FOREMAN_CLAUDE_SETTINGS, "utf8"));
  assert.equal(s.statusLine.command, "someone-elses-statusline");
});

test("--force replaces a foreign status line", () => {
  fs.writeFileSync(process.env.FOREMAN_CLAUDE_SETTINGS, JSON.stringify({
    statusLine: { type: "command", command: "someone-elses-statusline" },
  }));
  const r = claude.install({ bin: "foreman", force: true });
  assert.equal(r.statusLine, "replaced");
});

test("dry run writes nothing", () => {
  fs.writeFileSync(process.env.FOREMAN_CLAUDE_SETTINGS, "{}");
  const r = claude.install({ bin: "foreman", dryRun: true });
  assert.ok(r.added.length > 0);
  assert.equal(r.backup, null);
  assert.equal(fs.readFileSync(process.env.FOREMAN_CLAUDE_SETTINGS, "utf8"), "{}");
});

test("install backs up before writing", () => {
  fs.writeFileSync(process.env.FOREMAN_CLAUDE_SETTINGS, JSON.stringify({ marker: true }));
  const r = claude.install({ bin: "foreman" });
  assert.ok(r.backup && fs.existsSync(r.backup));
  assert.equal(JSON.parse(fs.readFileSync(r.backup, "utf8")).marker, true);
});

test("uninstall removes ours and leaves theirs", () => {
  fs.writeFileSync(process.env.FOREMAN_CLAUDE_SETTINGS, JSON.stringify({
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "my-own-script" }] }] },
  }));
  claude.install({ bin: "foreman" });
  claude.uninstall();
  const s = JSON.parse(fs.readFileSync(process.env.FOREMAN_CLAUDE_SETTINGS, "utf8"));
  const cmds = (s.hooks?.PreToolUse ?? []).flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(cmds.includes("my-own-script"));
  assert.ok(!cmds.some((c) => c.includes("foreman")));
  assert.ok(!s.statusLine);
});

test("status reports what is wired", () => {
  fs.writeFileSync(process.env.FOREMAN_CLAUDE_SETTINGS, "{}");
  claude.install({ bin: "foreman" });
  const s = claude.status();
  assert.equal(s.exists, true);
  assert.equal(s.statusLine, true);
  assert.deepEqual(s.missing, []);
});
