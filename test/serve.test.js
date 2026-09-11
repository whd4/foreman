// The dashboard feed against a folder with more sessions than anyone would look at.
//
// The bug these exist to prevent: 2,009 session directories were on disk on 2026-09-11 and
// reading every file on every 2 s poll took 5 s, so /api/state answered nothing and the
// widgets rendered stale numbers. What fixed it: unchanged sessions are not re-parsed, cold
// ones are not even stat'd until the sweep reaches them, and the feed carries the newest
// few plus everything live while the totals still cover every session on disk.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-serve-test-"));
process.env.FOREMAN_HOME = path.join(sandbox, "home");

const store = await import("../src/state.js");
const { snapshot, cachedSnapshotJson } = await import("../src/serve.js");
const { sessionDir, sessionHudFile, sessionStateFile, writeJson } = await import("../src/paths.js");

const NOW = Date.parse("2026-09-11T12:00:00.000Z");
const HOUR = 3600 * 1000;
const iso = (agoMs) => new Date(NOW - agoMs).toISOString();

/** Write a session straight to disk, bypassing emit/writeHud so current.json is untouched. */
function plant(id, { agoMs, outputTokens = 1 }) {
  fs.mkdirSync(sessionDir(id), { recursive: true });
  writeJson(sessionStateFile(id), { seq: 1, state: "idle", at: iso(agoMs), session: id }, { pretty: false });
  writeJson(sessionHudFile(id), { seq: 1, at: iso(agoMs), totals: { outputTokens } }, { pretty: false });
}

const COLD = Array.from({ length: 50 }, (_, i) => `cold-${String(i).padStart(3, "0")}`);
const LIVE = ["live-a", "live-b"];

test("the feed carries the newest few plus every live session, but counts them all", () => {
  COLD.forEach((id, i) => plant(id, { agoMs: (i + 2) * HOUR, outputTokens: 10 }));
  LIVE.forEach((id, i) => plant(id, { agoMs: i * 1000, outputTokens: 1000 }));

  const snap = snapshot({ now: NOW, limit: 5 });
  assert.equal(snap.aggregate.sessions, 52, "totals cover every session on disk");
  assert.equal(snap.aggregate.live, 2);
  assert.equal(snap.aggregate.totals.outputTokens, 50 * 10 + 2 * 1000);
  assert.equal(snap.sessions.length, 5, "the list is capped");
  assert.deepEqual(snap.sessions.slice(0, 2).map((s) => s.id), LIVE, "live sessions come first");
  for (let i = 1; i < snap.sessions.length; i++) {
    assert.ok(snap.sessions[i - 1].ageMs <= snap.sessions[i].ageMs, "not newest first");
  }
  assert.equal(snap.current?.id, "live-a", "with no current.json the newest live session stands in");
});

test("a limit smaller than the live count still carries every live session", () => {
  const snap = snapshot({ now: NOW, limit: 1 });
  assert.equal(snap.sessions.length, 2);
  assert.ok(snap.sessions.every((s) => s.active));
});

test("a change to a live session is seen on the very next call", () => {
  plant("live-a", { agoMs: 0, outputTokens: 5000 });
  const snap = snapshot({ now: NOW, limit: 5 });
  assert.equal(snap.sessions.find((s) => s.id === "live-a").tokens.output, 5000);
  assert.equal(snap.aggregate.totals.outputTokens, 50 * 10 + 5000 + 1000);
});

test("a brand-new session directory is seen on the very next call", () => {
  plant("live-c", { agoMs: 0, outputTokens: 7 });
  const snap = snapshot({ now: NOW, limit: 5 });
  assert.ok(snap.sessions.some((s) => s.id === "live-c"));
  assert.equal(snap.aggregate.sessions, 53);
});

test("a session directory that disappears drops out on the very next call", () => {
  fs.rmSync(sessionDir("cold-049"), { recursive: true, force: true });
  const snap = snapshot({ now: NOW, limit: 5 });
  assert.equal(snap.aggregate.sessions, 52);
  assert.equal(snap.aggregate.totals.outputTokens, 49 * 10 + 5000 + 1000 + 7);
});

test("cold sessions are not re-read until the sweep reaches them, one slice per call", () => {
  const changed = COLD.slice(0, 3);
  // still cold: the timestamp inside stays hours old, only the totals move
  changed.forEach((id, i) => plant(id, { agoMs: (i + 2) * HOUR, outputTokens: 999 }));
  const tokens = (rows) => changed.map((id) => rows.find((r) => r.id === id).hud.totals.outputTokens);

  // no sweep: the cache answers, the disk is not consulted
  assert.deepEqual(tokens(store.listSessions({ full: false, now: NOW, sweep: 0 })), [10, 10, 10]);

  // a one-wide sweep catches at most one of them per call ...
  let seen = 0;
  for (let i = 0; i < 52 && seen < 3; i++) {
    const after = tokens(store.listSessions({ full: false, now: NOW, sweep: 1 })).filter((t) => t === 999).length;
    assert.ok(after - seen <= 1, `sweep width 1 refreshed ${after - seen} cold sessions in one call`);
    seen = after;
  }
  // ... and all of them inside one rotation over every directory
  assert.equal(seen, 3);
});

test("a full walk (the CLI path) sees a cold change immediately", () => {
  plant("cold-010", { agoMs: 12 * HOUR, outputTokens: 4242 });
  const row = store.listSessions({ now: NOW }).find((r) => r.id === "cold-010");
  assert.equal(row.hud.totals.outputTokens, 4242);
  assert.equal(store.aggregate({ now: NOW }).totals.outputTokens, 45 * 10 + 3 * 999 + 4242 + 5000 + 1000 + 7);
});

test("one snapshot serves every poller inside the TTL, and a fresh one follows it", () => {
  const a = cachedSnapshotJson(NOW);
  assert.equal(cachedSnapshotJson(NOW + 500), a, "re-walked inside the TTL");
  plant("live-d", { agoMs: 0, outputTokens: 1 });
  assert.equal(cachedSnapshotJson(NOW + 900), a, "a poll inside the TTL must not see the new session yet");
  const c = cachedSnapshotJson(NOW + 1500);
  assert.notEqual(c, a);
  assert.ok(JSON.parse(c).sessions.some((s) => s.id === "live-d"));
});

test("resetSessionCache forgets everything and the next walk rebuilds it", () => {
  store.resetSessionCache();
  const snap = snapshot({ now: NOW, limit: 5 });
  assert.equal(snap.aggregate.sessions, 53);
  assert.equal(snap.aggregate.totals.outputTokens, 45 * 10 + 3 * 999 + 4242 + 5000 + 1000 + 7 + 1);
});
