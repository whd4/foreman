// The two small files everything else talks through.
//
//   state.json — "what is the agent doing right now" (written by hooks)
//   hud.json   — "what has it cost and how full is the context" (written by the status line)
//
// Split deliberately: they come from different sources at different rates, and a hook
// firing 20x a turn should not clobber cost data that only the status line knows.

import fs from "node:fs";
import { stateFile, hudFile, readJson, writeJson, configFile, ensureDir, configDir,
         sessionsDir, sessionDir, sessionStateFile, sessionHudFile, currentFile,
         safeSessionId } from "./paths.js";

const DEFAULT_CONFIG = {
  character: "crab",
  width: 0,
  height: 12,
  // What we believe the context window to be. An ASSERTION, not a measurement — the
  // transcript says how much was sent, never how much was allowed. 200000 is what Claude
  // Code's status line reported on 2026-07-30, and it looks wrong: Opus 5 is documented
  // at 1M, and a 288k-token prompt was being displayed as "55% of 200k". Set it with
  // `foreman set windowTokens 1000000`. `foreman sample` shouts when usage exceeds it.
  windowTokens: 200000,
  // Price preset name from transcript.js PRICES, or null. Null means cost is not
  // reported at all, which is correct: a made-up rate is worse than a blank.
  price: null,
};

export function getConfig() {
  return { ...DEFAULT_CONFIG, ...(readJson(configFile(), {}) || {}) };
}
export function setConfig(patch) {
  ensureDir(configDir());
  const next = { ...getConfig(), ...patch };
  writeJson(configFile(), next);
  return next;
}

/** Note which session was most recently active, so readers have a sensible default. */
function markCurrent(session) {
  if (!session) return;
  try { writeJson(currentFile(), { session: safeSessionId(session), at: new Date().toISOString() }, { pretty: false }); } catch {}
}

/** The most recently active session id, or null. */
export function currentSession() {
  return readJson(currentFile(), null)?.session ?? null;
}

/** A session whose last write is younger than this counts as live. */
export const FRESH_MS = 5 * 60 * 1000;

// ── the session cache ──────────────────────────────────────────────────────
//
// Never re-read a session file that has not changed. 2,009 session directories were on
// disk on 2026-09-11 and the dashboard polls every two seconds; reading all ~4,000 files
// per poll took 3.3 s on Windows, so the port answered nothing for hours. Each session's
// parsed files are kept here with the mtime and size they were read at: an unchanged
// session costs two stats and no parse, a changed one costs a read, and a cold one (see
// listSessions) costs nothing at all until the sweep reaches it.
const _cache = new Map();   // id -> { id, at, atMs, state, hud, sig }
const SWEEP_PER_CALL = 64;  // cold sessions re-checked per non-full call; ~35 ms of stats
let _sweepAt = 0;

function fileSig(file) {
  try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return "-"; }
}

/** Re-read one session only if either file's mtime or size moved since the last read. */
function refreshSession(id) {
  const sf = sessionStateFile(id), hf = sessionHudFile(id);
  const sig = `${fileSig(sf)}|${fileSig(hf)}`;
  const prev = _cache.get(id);
  if (prev && prev.sig === sig) return prev;
  const state = readJson(sf, null);
  const hud = readJson(hf, null);
  if (!state && !hud) { _cache.delete(id); return null; }
  const at = [state?.at, hud?.at].filter(Boolean).sort().pop() ?? null;
  const entry = { id, at, atMs: at ? Date.parse(at) : NaN, state, hud, sig };
  _cache.set(id, entry);
  return entry;
}

/** Forget everything read so far. Tests use it; so would a command that must see cold disk. */
export function resetSessionCache() { _cache.clear(); _sweepAt = 0; }

/**
 * Every session that has ever written, newest activity first.
 *
 * `full` (the default, and what the CLI wants) checks every session's files on every
 * call: two stats each, a parse only where something moved. `full: false` is the server
 * path: it checks only sessions live within FRESH_MS, the current session, anything not
 * seen before, and a rotating slice of `sweep` cold ones per call. A session that wakes
 * up after an hour is therefore seen on its next write (which makes it current) or when
 * the sweep reaches it — with 2,000 sessions polled every 2 s, inside about a minute.
 */
export function listSessions({ full = true, now = Date.now(), sweep = SWEEP_PER_CALL } = {}) {
  let ids = [];
  try { ids = fs.readdirSync(sessionsDir()); } catch { return []; }
  const cur = currentSession();

  // Anything that vanished from disk vanishes from memory too.
  if (_cache.size) {
    const present = new Set(ids);
    for (const id of _cache.keys()) if (!present.has(id)) _cache.delete(id);
  }

  // The sweep is a window over readdir order that advances every call and wraps.
  let lo = 0, hi = 0;
  if (!full && ids.length) {
    lo = _sweepAt % ids.length;
    hi = lo + sweep;
    _sweepAt = hi % ids.length;
  }

  const rows = [];
  ids.forEach((id, i) => {
    const cached = _cache.get(id);
    const swept = !full && ((i >= lo && i < hi) || i < hi - ids.length);
    const hot = !cached || id === cur || cached.atMs >= now - FRESH_MS || swept;
    const entry = full || hot ? refreshSession(id) : cached;
    if (entry) rows.push({ id, current: id === cur, at: entry.at, state: entry.state, hud: entry.hud });
  });
  return rows.sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")));
}

/**
 * Totals across every session.
 *
 * This is the number nobody else reports. Running several agents at once multiplies spend
 * with no combined view anywhere — each session only ever knows its own usage.
 *
 * Pass `sessions` (a listSessions result) to sum a walk you already did; otherwise this
 * walks itself, `full` by default.
 */
export function aggregate({ full = true, now = Date.now(), sessions = null } = {}) {
  const rows = sessions ?? listSessions({ full, now });
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, messages: 0 };
  let costUsd = null;
  let live = 0;

  for (const s of rows) {
    const t = s.hud?.totals;
    if (t) for (const k of Object.keys(totals)) totals[k] += Number(t[k]) || 0;
    if (Number.isFinite(s.hud?.costUsd)) costUsd = (costUsd ?? 0) + s.hud.costUsd;
    if (s.at && now - Date.parse(s.at) < FRESH_MS) live++;
  }
  return { sessions: rows.length, live, totals, costUsd };
}

/**
 * Record the current animation state. `seq` lets readers detect a change without polling
 * content. Pass `extra.session` to keep concurrent agents from overwriting each other.
 */
export function emit(state, extra = {}) {
  const session = extra.session ?? null;
  const file = session ? sessionStateFile(session) : stateFile();
  const prev = readJson(file, null);
  const next = {
    seq: (prev?.seq ?? 0) + 1,
    state,
    at: new Date().toISOString(),
    ...extra,
  };
  if (session) ensureDir(sessionDir(session));
  writeJson(file, next, { pretty: false });

  // The flat file stays as the "whatever happened most recently" view that `foreman watch`
  // shows by default. It is deliberately last-writer-wins; the per-session file is the
  // authoritative one.
  if (session) { writeJson(stateFile(), next, { pretty: false }); markCurrent(session); }
  return next;
}

export function readState({ session = null } = {}) {
  const file = session ? sessionStateFile(session) : stateFile();
  return readJson(file, { seq: 0, state: "idle", at: null });
}

export function writeHud(hud, { session = null } = {}) {
  const file = session ? sessionHudFile(session) : hudFile();
  const prev = readJson(file, null);
  const next = { seq: (prev?.seq ?? 0) + 1, at: new Date().toISOString(), ...hud };

  // Infer burn rate from the delta between refreshes. No source gives a rate, only a
  // running total, so this is the only place it can come from.
  //
  // Cost is preferred but is often absent now that readings come from the transcript,
  // which carries tokens and no prices. Output tokens are always present and are the
  // honest proxy for "how hard is it working right now", so they are the fallback —
  // better than freezing the animation at zero whenever cost is unknown.
  const dt = prev?.at ? Math.max(1, (Date.parse(next.at) - Date.parse(prev.at)) / 1000) : 0;
  if (prev && dt && Number.isFinite(prev.costUsd) && Number.isFinite(next.costUsd) && next.costUsd > prev.costUsd) {
    next.burn = Math.min(1, ((next.costUsd - prev.costUsd) / dt) * 60);
  } else if (prev && dt && Number.isFinite(prev.totals?.outputTokens) && Number.isFinite(next.totals?.outputTokens)
             && next.totals.outputTokens > prev.totals.outputTokens) {
    // ~1200 output tokens/min reads as flat out; scale to the same 0..1 the states expect
    next.burn = Math.min(1, (((next.totals.outputTokens - prev.totals.outputTokens) / dt) * 60) / 1200);
  } else {
    next.burn = prev?.burn ?? 0;
  }

  if (session) ensureDir(sessionDir(session));
  writeJson(file, next, { pretty: false });
  if (session) { writeJson(hudFile(), next, { pretty: false }); markCurrent(session); }
  return next;
}

export function readHud({ session = null } = {}) {
  const file = session ? sessionHudFile(session) : hudFile();
  return readJson(file, { seq: 0, ctxPct: 0, costUsd: 0, burn: 0 });
}

/**
 * What a tool DOES, independent of what an agent calls it.
 *
 * Every agent names its tools differently and goose namespaces them by extension
 * (`developer__shell`). Reducing to a verb here means a new agent costs one line in this
 * table rather than a second copy of the whole event mapping.
 */
export function toolKind(toolName = "", input = null) {
  // goose: `extension__tool`. Strip the extension so the tool name can be matched once.
  const t = String(toolName).replace(/^[A-Za-z0-9_]+?__/, "");

  if (/^(Read|NotebookRead)$/i.test(t)) return "read";
  if (/^(Grep|Glob|WebSearch|WebFetch|Search)$/i.test(t)) return "search";
  if (/^(Write|Edit|NotebookEdit)$/i.test(t)) return "edit";
  if (/^(Bash|PowerShell|Shell)$/i.test(t)) return "shell";
  if (/^(Agent|Task|Subagent)$/i.test(t)) return "agent";

  // goose's text_editor both reads and writes; only its `command` says which
  if (/^text_editor$/i.test(t)) {
    const cmd = String(input?.command ?? "").toLowerCase();
    return cmd === "view" ? "read" : "edit";
  }
  return null;
}

const KIND_STATE = { read: "read", search: "dig", edit: "type", shell: "hammer", agent: "summon" };

/**
 * Flatten an agent's hook payload into `{ event, tool, input, failed, transcriptPath }`.
 *
 * Claude Code sends `hook_event_name`; goose sends `event`. Normalising once means
 * stateForHook stays a single table instead of one branch per vendor.
 */
export function normalizeHook(payload) {
  const event = payload?.hook_event_name ?? payload?.event ?? null;
  const r = payload?.tool_response ?? null;
  return {
    event,
    tool: payload?.tool_name ?? "",
    input: payload?.tool_input ?? null,
    // Claude Code reports failure inside tool_response; goose has a dedicated event.
    failed: Boolean(r && (r.error || r.stderr || r.success === false)),
    // Both agents send session_id. Verified from a live Claude Code payload 2026-07-30,
    // whose keys were: cwd, duration_ms, effort, hook_event_name, permission_mode,
    // prompt_id, session_id, tool_input, tool_name, tool_response, tool_use_id,
    // transcript_path.
    session: payload?.session_id ?? null,
    transcriptPath: payload?.transcript_path ?? null,
    cwd: payload?.cwd ?? payload?.working_dir ?? null,
  };
}

/**
 * Map a hook payload to a state name, or null to leave the mascot alone.
 * Exported separately from the adapters so it can be unit-tested without touching disk.
 */
export function stateForHook(payload) {
  const { event, tool, input, failed } = normalizeHook(payload);

  switch (event) {
    // ── shared ────────────────────────────────────────────────────────────
    case "SessionStart":     return "wake";
    case "UserPromptSubmit": return "think";
    case "Stop":             return "flag";

    // ── Claude Code ───────────────────────────────────────────────────────
    case "Notification":     return "ping";
    case "PreCompact":       return "stopSign";
    case "SubagentStop":     return "flag";

    // ── goose ─────────────────────────────────────────────────────────────
    case "SessionEnd":            return "flag";
    case "PostToolUseFailure":    return "stumble";  // explicit, unlike Claude's inference
    case "BeforeReadFile":        return "read";
    case "AfterFileEdit":         return "type";
    case "BeforeShellExecution":  return "hammer";
    case "AfterShellExecution":   return null;       // the next Pre event covers it

    // ── both ──────────────────────────────────────────────────────────────
    case "PreToolUse":
      return KIND_STATE[toolKind(tool, input)] ?? "think";
    case "PostToolUse":
      return failed ? "stumble" : null;   // success is covered by the next PreToolUse

    default: return null;
  }
}
