#!/usr/bin/env node
// foreman — see what your coding agent is doing and what it's costing.
//
// Every command is safe to run twice. Nothing here writes to your repo, and the only
// file it ever modifies outside ~/.foreman is your agent's settings file, which is
// backed up first and merged rather than replaced.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { Surface, supportsColor } from "../src/render.js";
import { createEngine, STATES, stateNames } from "../src/engine.js";
import * as chars from "../src/character.js";
import * as store from "../src/state.js";
import { parsePayload, formatLine } from "../src/statusline.js";
import * as claude from "../src/adapters/claude-code.js";
import * as goose from "../src/adapters/goose.js";
import { renderSvg, poseSvg, propSvg, contactSheet } from "../src/svg.js";
import { liveDocument } from "../src/svg-live.js";
import { sample, PRICES, findTranscript } from "../src/transcript.js";
import { configDir, stateFile, hudFile, configFile } from "../src/paths.js";

const C = supportsColor();
const dim = (s) => (C ? `\x1b[2m${s}\x1b[0m` : s);
const b   = (s) => (C ? `\x1b[1m${s}\x1b[0m` : s);
const org = (s) => (C ? `\x1b[38;2;232;130;90m${s}\x1b[0m` : s);
const red = (s) => (C ? `\x1b[38;2;216;84;63m${s}\x1b[0m` : s);
const grn = (s) => (C ? `\x1b[38;2;99;201;124m${s}\x1b[0m` : s);
const ylw = (s) => (C ? `\x1b[38;2;229;181;79m${s}\x1b[0m` : s);

const ok   = (s) => console.log(`${grn("✓")} ${s}`);
const warn = (s) => console.log(`${ylw("!")} ${s}`);
const bad  = (s) => console.error(`${red("✗")} ${s}`);

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);
const flag = (n) => rest.includes(`--${n}`);

/** Value flags, written either `--name value` or `--name=value`. */
const VALUE_FLAGS = ["out", "scale", "t", "pose", "prop", "character", "ctx", "cost",
                     "window", "price", "transcript"];
const opt = (n, dflt = null) => {
  const eq = rest.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = rest.indexOf(`--${n}`);
  if (i >= 0 && rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) return rest[i + 1];
  return dflt;
};

// a value consumed by a flag is not also a positional argument
const consumed = new Set();
for (const n of VALUE_FLAGS) {
  const i = rest.indexOf(`--${n}`);
  if (i >= 0 && rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) consumed.add(i + 1);
}
const positional = rest.filter((a, i) => !a.startsWith("--") && !consumed.has(i));

function usage() {
  console.log(`
${org("foreman")} ${dim("— know what your agent is doing and what it's costing")}

  ${b("foreman init")} [agent]        wire up hooks + status line   ${dim("(default: claude-code)")}
  ${b("foreman watch")}              live character in this terminal
  ${b("foreman status")}              print the one-line readout    ${dim("(called by the status line)")}
  ${b("foreman hook")}               map a hook payload to a state ${dim("(called by hooks, reads stdin)")}
  ${b("foreman emit")} <state>        set the state by hand
  ${b("foreman sample")}             read cost + context from the transcript ${dim("(--json)")}
  ${b("foreman sessions")}           every agent running, and the combined total
  ${b("foreman set")} <key> <value>   windowTokens · price · character
  ${b("foreman svg")} [state]        render to SVG            ${dim("(--all, --live, --pose, --prop)")}
  ${b("foreman list")}                installed characters
  ${b("foreman use")} <character>     switch character
  ${b("foreman validate")} <file>     check a character pack
  ${b("foreman states")}              every state and what triggers it
  ${b("foreman doctor")}              what's wired, what isn't
  ${b("foreman uninstall")}           remove hooks + status line

${dim("flags")}  --dry-run   show changes without writing
       --force     replace an existing status line
       --once      render a single frame and exit ${dim("(watch)")}
       --no-color  plain output

${dim("svg")}    --all       every state on one page, for eyeballing the whole set
       --live      event-driven view for a desktop shell ${dim("(no animation loop)")}
       --out F     write to a file instead of stdout
       --scale N   pixels per sprite pixel · --t MS  time into the state
       --ctx N --cost N   drive the readout with numbers

${dim(`config ${configDir()}`)}
`);
}

// ── watch ────────────────────────────────────────────────────────────────
async function watch() {
  const cfg = store.getConfig();
  let pack;
  try { pack = chars.load(cfg.character); }
  catch (e) { bad(e.message); process.exit(1); }

  const cols = () => Math.max(pack.size[0] + 6, Math.min(process.stdout.columns || 60, 72));
  const ROWS = 7;                                  // 14 sprite pixels of headroom
  const hud = store.readHud();
  const eng = createEngine(pack, { width: cols(), height: ROWS * 2, hud });

  if (flag("once")) {
    eng.setState(store.readState().state ?? "idle");
    for (const line of eng.render(Date.now(), { autoFromHud: true, color: C })) console.log(line);
    return;
  }

  const surface = new Surface(ROWS + 1);
  let lastSeq = -1, lastHudSeq = -1, stop = false;

  const quit = () => {
    if (stop) return;
    stop = true;
    surface.stop();
    console.log(dim("stopped"));
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);

  process.stdout.on("resize", () => eng.resize(cols(), ROWS * 2));

  const tick = () => {
    if (stop) return;

    const st = store.readState();
    if (st.seq !== lastSeq) { lastSeq = st.seq; if (STATES[st.state]) eng.setState(st.state); }

    const h = store.readHud();
    if (h.seq !== lastHudSeq) { lastHudSeq = h.seq; Object.assign(hud, h); }

    const lines = eng.render(Date.now(), { autoFromHud: true, color: C });

    const pct = Math.round(hud.ctxPct ?? 0);
    const bars = 12, fill = Math.min(bars, Math.round((pct / 100) * bars));
    const meterCol = pct >= 85 ? red : pct >= 55 ? ylw : grn;
    const meter = meterCol("█".repeat(fill)) + dim("░".repeat(bars - fill));
    lines.push(
      `  ${meter} ${b(String(pct).padStart(3) + "%")}` +
      `   ${dim("spend")} ${b("$" + (hud.costUsd ?? 0).toFixed(2))}` +
      `   ${dim(eng.state)}`
    );

    surface.draw(lines);
    setTimeout(tick, 80);
  };
  tick();
}

// ── status line ──────────────────────────────────────────────────────────
async function statusCmd() {
  let raw = "";
  try {
    if (!process.stdin.isTTY) {
      for await (const chunk of process.stdin) raw += chunk;
    }
  } catch { /* fall through to an empty line */ }

  let payload = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch { payload = null; }

  if (!payload) {
    // Called by hand with no stdin — show what we last knew instead of nothing.
    const h = store.readHud();
    process.stdout.write(formatLine({
      ctxPct: h.ctxPct ?? 0, costUsd: h.costUsd ?? 0,
      linesAdded: h.linesAdded ?? 0, linesRemoved: h.linesRemoved ?? 0,
      model: h.model ?? "agent", dir: h.dir ?? "",
    }) + "\n");
    return;
  }

  const h = parsePayload(payload);
  try { store.writeHud(h); } catch { /* never let a write failure break the prompt */ }
  process.stdout.write(formatLine(h) + "\n");
}

// ── hook ─────────────────────────────────────────────────────────────────
async function hookCmd() {
  let raw = "";
  try {
    if (!process.stdin.isTTY) for await (const chunk of process.stdin) raw += chunk;
  } catch { return; }

  let payload = null;
  try { payload = raw ? JSON.parse(raw) : null; } catch { return; }
  if (!payload) return;

  // Normalised, so `via` is populated for goose ("event") as well as Claude Code
  // ("hook_event_name") rather than silently landing undefined.
  const norm = store.normalizeHook(payload);
  const state = store.stateForHook(payload);
  if (state) {
    // Keyed by session so concurrent agents stop overwriting one another.
    try { store.emit(state, { via: norm.event, tool: norm.tool || null, session: norm.session }); }
    catch { /* silent */ }
  }

  // Refresh the numbers from the transcript. This is the whole reason cost and context
  // are live at all: the status line is the only surface that carries them and it does
  // not fire reliably, while this runs on every single tool call. Every failure mode is
  // swallowed — a hook that throws or hangs would break the user's agent, and a stale
  // readout is a far smaller problem than that.
  try { sampleIntoHud(norm.transcriptPath, norm.session); } catch { /* never break the hook */ }
}

/** Read the transcript and persist a HUD reading. Returns the sample, or null. */
function sampleIntoHud(transcriptPath, session = null) {
  const cfg = store.getConfig();
  const prev = store.readHud({ session });
  const s = sample({
    transcriptPath,
    prev,
    windowTokens: cfg.windowTokens ?? null,
    windowSource: cfg.windowTokens ? "foreman config windowTokens" : null,
    price: cfg.price ? PRICES[cfg.price] ?? null : null,
  });
  if (!s) return null;
  store.writeHud({ ...s, session }, { session });
  return s;
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  switch (cmd) {
    case undefined:
    case "-h": case "--help": case "help":
      usage(); break;

    case "-v": case "--version": {
      const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
      console.log(pkg.version); break;
    }

    case "init": {
      const agent = positional[0] ?? "claude-code";
      if (agent !== "claude-code" && agent !== "goose") {
        bad(`no adapter for '${agent}'. Available: claude-code, goose`); process.exit(1);
      }

      if (agent === "goose") {
        if (!goose.detect()) warn(`${goose.pluginDir()} does not exist yet — it will be created`);
        const r = goose.install({ dryRun: flag("dry-run") });
        console.log(`\n${b(goose.label)} ${dim(r.file)}`);
        if (r.backup) console.log(dim(`  backup  ${r.backup}`));
        ok(`${r.created ? "installed" : "updated"} plugin — ${r.events.length} events: ${r.events.join(", ")}`);
        for (const w of r.warnings) warn(w);
        if (r.dryRun) warn("dry run — nothing was written");
        else console.log(`\n${dim("restart goose, then run")} ${b("foreman watch")}\n`);
        break;
      }

      if (!claude.detect()) warn("no Claude Code settings file found — one will be created");

      const r = claude.install({ dryRun: flag("dry-run"), force: flag("force") });
      console.log(`\n${b(claude.label)} ${dim(r.file)}`);
      if (r.backup) console.log(dim(`  backup  ${r.backup}`));
      if (r.added.length)   ok(`hooks added: ${r.added.join(", ")}`);
      if (r.skipped.length) console.log(dim(`  already present: ${r.skipped.join(", ")}`));
      console.log(`  status line: ${r.statusLine === "kept" ? ylw(r.statusLine) : grn(r.statusLine)}`);
      for (const w of r.warnings) warn(w);
      if (r.dryRun) warn("dry run — nothing was written");
      else console.log(`\n${dim("restart your agent, then run")} ${b("foreman watch")}\n`);
      break;
    }

    case "uninstall": {
      if (positional[0] === "goose") {
        const g = goose.uninstall({ dryRun: flag("dry-run") });
        if (g.backup) console.log(dim(`backup  ${g.backup}`));
        ok(g.removed ? `removed ${g.file}` : "nothing to remove");
        if (g.dryRun) warn("dry run — nothing was written");
        break;
      }
      const r = claude.uninstall({ dryRun: flag("dry-run") });
      if (r.backup) console.log(dim(`backup  ${r.backup}`));
      ok(`hooks removed from: ${r.removed.length ? r.removed.join(", ") : "nothing to remove"}`);
      console.log(`status line: ${r.statusLine}`);
      if (r.dryRun) warn("dry run — nothing was written");
      break;
    }

    case "watch": await watch(); break;
    case "status": await statusCmd(); break;
    case "hook": await hookCmd(); break;

    case "emit": {
      const s = positional[0];
      if (!s) { bad("which state? try: foreman states"); process.exit(1); }
      if (!STATES[s]) { bad(`unknown state '${s}'. Run 'foreman states'.`); process.exit(1); }
      store.emit(s);
      ok(`state = ${org(s)}`);
      break;
    }

    case "sample": {
      const cfg = store.getConfig();
      const win = opt("window") ? Number(opt("window")) : cfg.windowTokens ?? null;
      const priceKey = opt("price") ?? cfg.price ?? null;
      if (priceKey && !PRICES[priceKey]) {
        bad(`no price preset '${priceKey}'. Known: ${Object.keys(PRICES).join(", ") || "(none)"}`);
        process.exit(1);
      }

      const s = sample({
        transcriptPath: opt("transcript") ?? undefined,
        prev: store.readHud(),
        windowTokens: Number.isFinite(win) ? win : null,
        windowSource: opt("window") ? "--window" : cfg.windowTokens ? "foreman config windowTokens" : null,
        price: priceKey ? PRICES[priceKey] : null,
      });

      if (!s) {
        bad("no transcript found. Pass --transcript <file>, or run this from the directory your agent is working in.");
        process.exit(1);
      }
      if (!flag("dry-run")) store.writeHud(s);
      if (flag("json")) { console.log(JSON.stringify(s, null, 2)); break; }

      const t = s.totals;
      const n = (v) => Number(v ?? 0).toLocaleString("en-US");
      console.log(`\n  ${b("context")} ${dim("(measured — exact token counts from the transcript)")}`);
      console.log(`    prompt on last call  ${b(n(s.ctxUsed))} tokens`);
      if (s.ctxPct !== null) {
        const col = s.windowExceeded ? red : s.ctxPct >= 85 ? red : s.ctxPct >= 55 ? ylw : grn;
        console.log(`    of assumed window    ${col(s.ctxPct + "%")} ${dim(`(${n(s.ctxSize)} — ${s.windowSource})`)}`);
      } else {
        warn("no window size set, so no percentage. Set one: foreman set windowTokens 1000000");
      }
      if (s.windowExceeded) {
        bad(`usage EXCEEDS the assumed window — the window setting is wrong, not the usage.`);
        console.log(`      ${dim("Opus 5 is documented at 1M. Try: foreman set windowTokens 1000000")}`);
      }

      console.log(`\n  ${b("session totals")} ${dim(`(${n(t.messages)} assistant messages)`)}`);
      console.log(`    input ${n(t.inputTokens)}   output ${n(t.outputTokens)}`);
      console.log(`    cache read ${n(t.cacheReadTokens)}   cache write ${n(t.cacheCreateTokens)}`);

      console.log(`\n  ${b("cost")}`);
      if (s.costUsd === null) {
        console.log(`    ${dim("not reported — no price set. A guessed rate is worse than a blank.")}`);
        const known = Object.keys(PRICES);
        if (known.length) console.log(`    ${dim(`set one: foreman set price ${known[0]}`)}`);
      } else {
        console.log(`    ${b("~$" + s.costUsd.toFixed(2))} ${ylw("ESTIMATE")} ${dim(s.costBasis.label)}`);
        console.log(`    ${dim("source: " + s.costBasis.source)}`);
        if (s.costBasis.note) console.log(`    ${ylw("!")} ${dim(s.costBasis.note)}`);
        console.log(`    ${dim(`excludes ${n(s.costBasis.excludesCacheReads)} cache-read tokens — billed at a rate not verified here`)}`);
      }
      console.log(`\n  ${dim(`model ${s.model ?? "?"} · ${s.speed ?? "?"} · ${s.serviceTier ?? "?"}`)}`);
      console.log(`  ${dim(s.tx.file)}\n`);
      break;
    }

    case "sessions": {
      const rows = store.listSessions();
      if (!rows.length) { warn("no sessions recorded yet — they appear on the first tool call after init"); break; }

      const agg = store.aggregate();
      const n = (v) => Number(v ?? 0).toLocaleString("en-US");
      const ago = (at) => {
        if (!at) return "—";
        const s = Math.max(0, (Date.now() - Date.parse(at)) / 1000);
        return s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
      };

      console.log("");
      for (const r of rows) {
        const live = r.at && Date.now() - Date.parse(r.at) < 5 * 60 * 1000;
        const mark = r.current ? org("●") : live ? grn("○") : dim("·");
        const h = r.hud ?? {};
        const pct = Number.isFinite(h.ctxPct) ? `${Math.round(h.ctxPct)}%`.padStart(4) : "   —";
        const tok = h.ctxUsed ? n(h.ctxUsed).padStart(9) : "        —";
        const col = !Number.isFinite(h.ctxPct) ? dim : h.ctxPct >= 85 ? red : h.ctxPct >= 55 ? ylw : grn;
        console.log(`  ${mark} ${b(r.id.slice(0, 8))} ${dim(ago(r.at).padStart(4))}  ` +
                    `${col(pct)} ${dim(tok + " tok")}  ${dim((r.state?.state ?? "—").padEnd(9))}` +
                    `${h.windowExceeded ? red("  window setting wrong") : ""}`);
      }

      // The point of keying by session: nowhere else adds these up. Running four agents
      // is four times the spend, and every other tool shows you one quarter of it.
      console.log(`\n  ${b("all sessions combined")} ${dim(`(${agg.live} active in the last 5 min, ${agg.sessions} total)`)}`);
      console.log(`    output ${n(agg.totals.outputTokens)}   input ${n(agg.totals.inputTokens)}`);
      console.log(`    cache read ${n(agg.totals.cacheReadTokens)}   cache write ${n(agg.totals.cacheCreateTokens)}`);
      console.log(`    ${n(agg.totals.messages)} assistant messages`);
      if (agg.costUsd === null) console.log(`    ${dim("cost not reported — no price set (foreman set price ...)")}`);
      else console.log(`    ${b("~$" + agg.costUsd.toFixed(2))} ${ylw("ESTIMATE")} ${dim("summed across sessions")}`);
      console.log("");
      break;
    }

    case "set": {
      const key = positional[0], val = positional[1];
      const ALLOWED = ["windowTokens", "price", "character"];
      if (!key || val === undefined) {
        console.log(`\n  ${b("foreman set <key> <value>")}\n`);
        const cfg = store.getConfig();
        for (const k of ALLOWED) console.log(`    ${org(k.padEnd(14))} ${dim(String(cfg[k] ?? "(unset)"))}`);
        console.log(`\n  ${dim("price presets: " + (Object.keys(PRICES).join(", ") || "(none)"))}\n`);
        break;
      }
      if (!ALLOWED.includes(key)) { bad(`unknown key '${key}'. One of: ${ALLOWED.join(", ")}`); process.exit(1); }

      let parsed = val;
      if (key === "windowTokens") {
        parsed = Number(val);
        if (!Number.isFinite(parsed) || parsed <= 0) { bad("windowTokens must be a positive number"); process.exit(1); }
      }
      if (key === "price") {
        if (val === "none" || val === "null") parsed = null;
        else if (!PRICES[val]) { bad(`no price preset '${val}'. Known: ${Object.keys(PRICES).join(", ") || "(none)"}`); process.exit(1); }
      }
      if (key === "character") {
        try { chars.load(val); } catch (e) { bad(e.message); process.exit(1); }
      }
      store.setConfig({ [key]: parsed });
      ok(`${key} = ${org(String(parsed))}`);
      break;
    }

    case "svg": {
      const cfg = store.getConfig();
      let pack;
      try { pack = chars.load(opt("character") ?? cfg.character); }
      catch (e) { bad(e.message); process.exit(1); }

      const scale = Number(opt("scale", flag("all") ? 4 : 8));
      const t = Number(opt("t", 900));
      const hud = {};
      if (opt("ctx") !== null)  hud.ctxPct  = Number(opt("ctx"));
      if (opt("cost") !== null) hud.costUsd = Number(opt("cost"));

      let body, kind;
      try {
        if (flag("live")) {
          body = liveDocument(pack, { scale, state: positional[0] ?? "idle" });
          kind = "live view";
        } else if (flag("all")) {
          body = contactSheet(pack, { t, scale, hud });
          kind = `contact sheet — ${stateNames().length} states`;
        } else if (opt("pose")) {
          body = poseSvg(pack, opt("pose"), { scale });
          kind = `pose ${opt("pose")}`;
        } else if (opt("prop")) {
          body = propSvg(pack, opt("prop"), { scale });
          kind = `prop ${opt("prop")}`;
        } else {
          const state = positional[0] ?? store.readState().state ?? "idle";
          if (!STATES[state]) { bad(`unknown state '${state}'. Run 'foreman states'.`); process.exit(1); }
          body = renderSvg(pack, { state, t, hud, scale, autoFromHud: Object.keys(hud).length > 0 });
          kind = `state ${state}`;
        }
      } catch (e) { bad(e.message); process.exit(1); }

      const out = opt("out");
      if (!out) { process.stdout.write(body + "\n"); break; }

      const file = path.resolve(out);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      ok(`${org(pack.name)} ${dim(kind)} → ${file} ${dim(`(${(Buffer.byteLength(body) / 1024).toFixed(1)} kB)`)}`);
      break;
    }

    case "list": {
      const items = chars.list();
      const active = store.getConfig().character;
      if (!items.length) { warn("no characters found"); break; }
      console.log("");
      for (const it of items) {
        const mark = it.name === active ? org("●") : dim("○");
        const health = it.ok ? "" : red("  invalid");
        console.log(`  ${mark} ${b(it.name.padEnd(14))} ${dim(`${it.poses} poses  ${it.props} props`)}` +
                    `  ${dim(it.license ?? "no license")}${health}`);
      }
      console.log(`\n  ${dim("switch with")} foreman use <name>\n`);
      break;
    }

    case "use": {
      const name = positional[0];
      if (!name) { bad("which character? try: foreman list"); process.exit(1); }
      try { chars.load(name); } catch (e) { bad(e.message); process.exit(1); }
      store.setConfig({ character: name });
      ok(`character = ${org(name)}`);
      break;
    }

    case "validate": {
      const target = positional[0];
      if (!target) { bad("which file?"); process.exit(1); }
      const file = path.resolve(target);
      if (!fs.existsSync(file)) { bad(`${file} does not exist`); process.exit(1); }
      let pack;
      try { pack = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (e) { bad(`not valid JSON: ${e.message}`); process.exit(1); }

      const v = chars.validate(pack);
      for (const w of v.warnings) warn(w);
      if (v.ok) { ok(`${pack.name ?? file} is a valid character pack`); }
      else {
        bad(`${pack.name ?? file} is invalid:`);
        for (const e of v.errors) console.error(`    ${red("-")} ${e}`);
        process.exit(1);
      }
      break;
    }

    case "states": {
      const groups = {};
      for (const [name, st] of Object.entries(STATES)) (groups[st.group] ??= []).push([name, st]);
      for (const [g, list] of Object.entries(groups)) {
        console.log(`\n  ${dim(g.toUpperCase())}`);
        for (const [name, st] of list)
          console.log(`    ${org(name.padEnd(11))} ${dim(st.trigger.padEnd(28))} ${st.why}`);
      }
      console.log("");
      break;
    }

    case "doctor": {
      const s = claude.status();
      const cfg = store.getConfig();
      console.log(`\n  ${b("character")}`);
      try {
        const p = chars.load(cfg.character);
        ok(`${cfg.character} — ${p.size[0]}x${p.size[1]}, ${Object.keys(p.poses).length} poses, ${Object.keys(p.props).length} props`);
      } catch (e) { bad(e.message); }

      console.log(`\n  ${b("claude code")} ${dim(s.file)}`);
      if (!s.exists) { bad("settings file not found — run: foreman init"); }
      else {
        if (s.hooks.length) ok(`hooks wired: ${s.hooks.join(", ")}`);
        else bad("no hooks wired — run: foreman init");
        if (s.missing?.length) warn(`not wired: ${s.missing.join(", ")}`);
        // Cost and context come from the transcript now, so a missing status line is
        // cosmetic. Saying otherwise sends people to fix the wrong thing.
        if (s.statusLine) ok("status line wired (prints the readout; the numbers come from the transcript)");
        else if (s.foreignStatusLine) console.log(dim("    another status line is installed — fine, the numbers don't depend on it"));
        else console.log(dim("    no status line — optional; the numbers come from the transcript"));
      }

      const g = goose.status();
      console.log(`\n  ${b("goose")} ${dim(g.file)}`);
      if (!g.exists) console.log(dim("    not installed — run: foreman init goose"));
      else {
        ok(`plugin wired: ${g.events.length} events`);
        if (g.missing.length) warn(`not wired: ${g.missing.join(", ")}`);
        warn("goose sends no transcript path, so cost and context stay empty there");
      }

      console.log(`\n  ${b("runtime")}`);
      const st = store.readState(), h = store.readHud();
      console.log(`    ${dim("state ")} ${st.state} ${dim(`(seq ${st.seq}${st.at ? ", " + st.at : ""})`)}`);
      const pct = h.ctxPct === null || h.ctxPct === undefined ? "—" : `${Math.round(h.ctxPct)}%`;
      const usd = Number.isFinite(h.costUsd) ? `$${h.costUsd.toFixed(2)}` : dim("no price set");
      console.log(`    ${dim("hud   ")} ctx ${pct}  ${usd} ${dim(`(seq ${h.seq}, via ${h.src ?? "status line"})`)}`);
      if (h.ctxUsed) console.log(`    ${dim("tokens")} ${Number(h.ctxUsed).toLocaleString("en-US")} in the last prompt`);

      // The failure that hid for 76 minutes: hooks firing while the numbers sat frozen.
      // Compare the two clocks and say so outright rather than showing a stale figure.
      const stAge = st.at ? (Date.now() - Date.parse(st.at)) / 1000 : null;
      const hAge  = h.at  ? (Date.now() - Date.parse(h.at))  / 1000 : null;
      if ((h.seq ?? 0) === 0) {
        warn("no readings yet — they populate on the next tool call after init");
      } else if (stAge !== null && hAge !== null && hAge - stAge > 120) {
        bad(`the numbers are ${Math.round((hAge - stAge) / 60)} min staler than the state — something stopped feeding them`);
        console.log(`    ${dim("if hud.src is 'status line', switch to the transcript: re-run foreman init")}`);
      }
      if (h.windowExceeded) {
        bad(`usage exceeds the configured window (${Number(h.ctxSize).toLocaleString("en-US")}) — that setting is wrong`);
        console.log(`    ${dim("try: foreman set windowTokens 1000000")}`);
      }
      console.log(`\n    ${dim(configFile())}\n    ${dim(stateFile())}\n    ${dim(hudFile())}\n`);
      break;
    }

    default:
      bad(`unknown command '${cmd}'`);
      usage();
      process.exit(1);
  }
}

main().catch((e) => { bad(e?.stack || String(e)); process.exit(1); });
