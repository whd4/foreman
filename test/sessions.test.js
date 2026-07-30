// Per-session storage.
//
// The bug these exist to prevent: three live Claude Code sessions were observed on one
// machine writing hooks into the same state.json and hud.json. Last writer won, so the
// readout showed a random session's numbers and nobody could tell.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-sess-test-"));
process.env.FOREMAN_HOME = path.join(sandbox, "home");
process.env.FOREMAN_CLAUDE_SETTINGS = path.join(sandbox, "claude", "settings.json");

const store = await import("../src/state.js");
const { safeSessionId, sessionDir, sessionsDir } = await import("../src/paths.js");

const A = "a42b2fcb-b530-48fe-9577-2e3c6d86fd93";
const B = "3d273174-1e0e-48e4-9c99-e7a4740df253";

test("two sessions do not overwrite each other", () => {
  store.emit("hammer", { session: A, tool: "Bash" });
  store.emit("read", { session: B, tool: "Read" });

  assert.equal(store.readState({ session: A }).state, "hammer");
  assert.equal(store.readState({ session: B }).state, "read");
});

test("each session keeps its own seq", () => {
  const before = store.readState({ session: A }).seq;
  store.emit("type", { session: A });
  store.emit("dig", { session: B });
  store.emit("dig", { session: B });
  assert.equal(store.readState({ session: A }).seq, before + 1, "A's seq moved by another session");
});

test("HUD readings are per session too", () => {
  store.writeHud({ ctxUsed: 100000, ctxPct: 10, totals: { outputTokens: 10 } }, { session: A });
  store.writeHud({ ctxUsed: 900000, ctxPct: 90, totals: { outputTokens: 900 } }, { session: B });
  assert.equal(store.readHud({ session: A }).ctxPct, 10);
  assert.equal(store.readHud({ session: B }).ctxPct, 90);
});

test("the flat file still tracks the most recent activity", () => {
  // `foreman watch` with no arguments relies on this staying last-writer-wins
  store.emit("flag", { session: A });
  assert.equal(store.readState().state, "flag");
  store.emit("stumble", { session: B });
  assert.equal(store.readState().state, "stumble");
  assert.equal(store.currentSession(), B);
});

test("no session id still works, for callers that have none", () => {
  store.emit("idle");
  assert.equal(store.readState().state, "idle");
});

test("listSessions returns both, newest first, flagging the current one", () => {
  const rows = store.listSessions();
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(A) && ids.includes(B), `got ${ids.join(", ")}`);
  assert.equal(rows.filter((r) => r.current).length, 1);
  const times = rows.map((r) => r.at).filter(Boolean);
  assert.deepEqual(times, [...times].sort().reverse(), "not sorted newest first");
});

test("aggregate sums usage across every session", () => {
  // the number nobody else reports: four agents is four times the spend, and every
  // other tool shows you one quarter of it
  const agg = store.aggregate();
  assert.ok(agg.sessions >= 2);
  assert.equal(agg.totals.outputTokens, 910, "should be 10 from A plus 900 from B");
});

test("aggregate adds cost only when sessions actually report it", () => {
  const before = store.aggregate();
  assert.equal(before.costUsd, null, "no price set anywhere, so no total");

  store.writeHud({ costUsd: 1.5, totals: { outputTokens: 0 } }, { session: A });
  store.writeHud({ costUsd: 2.25, totals: { outputTokens: 0 } }, { session: B });
  assert.equal(store.aggregate().costUsd, 3.75);
});

// ── the session id comes from an untrusted payload ──────────────────────────
test("a hostile session id cannot escape the sessions directory", () => {
  const root = path.resolve(sessionsDir());
  for (const evil of ["../../../../etc/passwd", "..", "../", "./..", "\\..\\..", "..\\..\\config.json"]) {
    const id = safeSessionId(evil);
    assert.ok(!/[\\/]/.test(id), `${evil} kept a separator: ${id}`);
    const dir = path.resolve(sessionDir(evil));
    assert.ok(dir.startsWith(root + path.sep), `${evil} escaped to ${dir}`);
  }
});

test("an id of only dots resolves to the parent, so it is rejected outright", () => {
  // ".." survives a separator-stripping filter and lands on the top-level config
  assert.equal(safeSessionId(".."), "unknown");
  assert.equal(safeSessionId("."), "unknown");
  assert.equal(safeSessionId("....."), "unknown");
  assert.equal(path.resolve(sessionDir("..")), path.resolve(path.join(sessionsDir(), "unknown")));
});

test("an empty or absurd session id degrades safely", () => {
  assert.equal(safeSessionId(""), "unknown");
  assert.equal(safeSessionId(null), "unknown");
  assert.ok(safeSessionId("x".repeat(500)).length <= 128);
});

test("writing under a hostile id does not create files outside the sandbox", () => {
  store.emit("idle", { session: "../escape" });
  const root = path.resolve(sessionsDir());
  for (const id of fs.readdirSync(root)) {
    assert.ok(path.resolve(path.join(root, id)).startsWith(root), `${id} escaped`);
  }
});

test("normalizeHook picks up session_id from both agents", () => {
  assert.equal(store.normalizeHook({ session_id: "abc" }).session, "abc");
  assert.equal(store.normalizeHook({ event: "PreToolUse", session_id: "goose-1" }).session, "goose-1");
  assert.equal(store.normalizeHook({}).session, null);
});
