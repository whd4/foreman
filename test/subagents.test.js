// Message dedup and subagent accounting — the two things that decide whether the token
// totals are true.
//
// These cover code that ships in `src/transcript.js` and is called on every hook:
// `scanTotals`'s message-id dedup, plus `subagentDir` / `scanSubagents`, which had no test
// coverage at all until this file.
//
// Two measured facts motivate everything here:
//
//   1. Claude writes MULTIPLE JSONL records for one streamed assistant message, each
//      carrying a CUMULATIVE usage snapshot under the same `message.id`. Summing every
//      record counts the same tokens repeatedly — a 2.65x output overcount on a live
//      3.5 MB transcript (788,424 naive vs 296,971 correct).
//
//   2. Subagent transcripts live in a sibling TREE, `<session>/subagents/**/*.jsonl`.
//      Scanning only the main file missed 49% of all activity in a live session — 3.40 MB
//      of subagent transcript against 3.55 MB of main. A cost instrument blind to agent
//      spend is no instrument at all.
//
// Everything runs against fixtures in a temp dir; no real transcript is read.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-sub-test-"));
process.env.FOREMAN_HOME = path.join(sandbox, "home");
process.env.FOREMAN_CLAUDE_SETTINGS = path.join(sandbox, "claude", "settings.json");

const { sample, scanTotals, scanSubagents, subagentDir, PRICES } =
  await import("../src/transcript.js");

let n = 0;
const tmpFile = () => path.join(sandbox, `t${++n}.jsonl`);

/**
 * One assistant record with the usage shape Claude Code actually writes.
 *
 * `id` is `message.id`. It is omitted from the JSON entirely when not supplied, which is
 * what exercises scanTotals's anonymous-record path. Records that DO carry an id are how a
 * streamed message's successive cumulative snapshots are tied together.
 */
function rec({ id, input = 0, out = 0, cacheRead = 0, cacheCreate = 0, model = "claude-opus-5", ts = "2026-07-30T18:00:00.000Z" } = {}) {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: {
      ...(id === undefined ? {} : { id }),
      model,
      usage: {
        input_tokens: input,
        output_tokens: out,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheCreate,
        service_tier: "standard",
        speed: "standard",
      },
    },
  });
}

function write(lines) {
  const f = tmpFile();
  fs.writeFileSync(f, lines.join("\n") + "\n");
  return f;
}

/** A subagent transcript for `mainFile`, at `rel` inside that session's subagents tree. */
function writeSub(mainFile, rel, lines) {
  const f = path.join(subagentDir(mainFile), rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, lines.join("\n") + "\n");
  return f;
}

// ── one record is not one message ───────────────────────────────────────────
test("successive snapshots of one message count once, at the final value", () => {
  const f = write([rec({ id: "msg_A", input: 4, out: 2, cacheRead: 1000, cacheCreate: 7 }),
                   rec({ id: "msg_A", input: 4, out: 900, cacheRead: 1000, cacheCreate: 7 }),
                   rec({ id: "msg_A", input: 4, out: 2047, cacheRead: 1000, cacheCreate: 7 })]);
  const s = scanTotals(f, { fromOffset: 0 });

  assert.equal(s.totals.outputTokens, 2047, "naive sum would be 2949");
  assert.equal(s.totals.inputTokens, 4, "cumulative fields dedup too — naive sum would be 12");
  assert.equal(s.totals.cacheReadTokens, 1000);
  assert.equal(s.totals.cacheCreateTokens, 7);
  assert.equal(s.totals.messages, 1, "three records, one message");

  // the mid-stream carry the next sample needs
  assert.equal(s.message.id, "msg_A");
  assert.equal(s.message.counted.outputTokens, 2047);
});

test("a message still streaming when a sample stops is finished, not re-added", () => {
  // the resume case: sample 1 sees 2 -> 900, sample 2 sees the 2047 snapshot
  const f = tmpFile();
  fs.writeFileSync(f, [rec({ id: "msg_A", input: 4, out: 2 }),
                       rec({ id: "msg_A", input: 4, out: 900 })].join("\n") + "\n");
  const a = scanTotals(f, { fromOffset: 0 });
  assert.equal(a.totals.outputTokens, 900);
  assert.equal(a.totals.messages, 1);

  fs.appendFileSync(f, rec({ id: "msg_A", input: 4, out: 2047 }) + "\n");
  const b = scanTotals(f, { fromOffset: a.offset, prevTotals: a.totals, prevMessage: a.message });

  assert.deepEqual(b.totals, scanTotals(f, { fromOffset: 0 }).totals, "resume must match a fresh full scan");
  assert.equal(b.totals.outputTokens, 2047);
  assert.equal(b.totals.inputTokens, 4);
  assert.equal(b.totals.messages, 1);
});

test("dropping prevMessage is what double counts — it is load bearing", () => {
  // characterizing WHY the option exists: without the carry, the final snapshot of a
  // message that was mid-stream at the last sample reads as a brand new message
  const f = tmpFile();
  fs.writeFileSync(f, [rec({ id: "msg_A", out: 2 }), rec({ id: "msg_A", out: 900 })].join("\n") + "\n");
  const a = scanTotals(f, { fromOffset: 0 });
  fs.appendFileSync(f, rec({ id: "msg_A", out: 2047 }) + "\n");

  const withCarry = scanTotals(f, { fromOffset: a.offset, prevTotals: a.totals, prevMessage: a.message });
  const without   = scanTotals(f, { fromOffset: a.offset, prevTotals: a.totals });

  assert.equal(withCarry.totals.outputTokens, 2047);
  assert.equal(without.totals.outputTokens, 2947, "900 + 2047 — the overcount, reproduced");
  assert.equal(without.totals.messages, 2);
});

test("a message streamed across many samples still lands on its final value", () => {
  // sampling fires on every tool call, so a long message gets sampled repeatedly
  const f = tmpFile();
  fs.writeFileSync(f, rec({ id: "m", out: 2 }) + "\n");
  let st = scanTotals(f, { fromOffset: 0 });
  for (const out of [120, 900, 1500, 2047]) {
    fs.appendFileSync(f, rec({ id: "m", out }) + "\n");
    st = scanTotals(f, { fromOffset: st.offset, prevTotals: st.totals, prevMessage: st.message });
  }
  assert.equal(st.totals.outputTokens, 2047);
  assert.equal(st.totals.messages, 1);
  assert.deepEqual(st.totals, scanTotals(f, { fromOffset: 0 }).totals);
});

test("records with no id each count as their own message", () => {
  // no id means no way to dedup, so they must NOT collapse into one another
  const f = write([rec({ out: 10 }), rec({ out: 20 }), rec({ out: 30 })]);
  const s = scanTotals(f, { fromOffset: 0 });
  assert.equal(s.totals.outputTokens, 60);
  assert.equal(s.totals.messages, 3);
});

test("an id-less record between two messages does not merge into either", () => {
  const f = write([rec({ id: "m1", out: 10 }), rec({ id: "m1", out: 20 }),
                   rec({ out: 5 }),
                   rec({ id: "m2", out: 7 })]);
  const s = scanTotals(f, { fromOffset: 0 });
  assert.equal(s.totals.outputTokens, 32, "m1 dedups to 20, the anon record adds 5, m2 adds 7");
  assert.equal(s.totals.messages, 3);
});

test("id-less records across a resume are not mistaken for one another", () => {
  // the synthetic id is scoped to the scan's start offset, so two anonymous records read
  // by different samples can never collide and silently dedup
  const f = tmpFile();
  fs.writeFileSync(f, rec({ out: 10 }) + "\n");
  const a = scanTotals(f, { fromOffset: 0 });
  fs.appendFileSync(f, rec({ out: 20 }) + "\n");
  const b = scanTotals(f, { fromOffset: a.offset, prevTotals: a.totals, prevMessage: a.message });
  assert.equal(b.totals.outputTokens, 30);
  assert.equal(b.totals.messages, 2);
});

test("dedup assumes one message's snapshots are contiguous", () => {
  // Characterizing a deliberate limit, not endorsing it: only the PREVIOUS id is carried,
  // which is what keeps the scan O(new bytes) with no growing map. Real transcripts write
  // a message's snapshots back to back, so an id that reappears after a different id is
  // treated as new. If that assumption ever breaks, this test is the tripwire.
  const f = write([rec({ id: "m1", out: 10 }), rec({ id: "m2", out: 5 }), rec({ id: "m1", out: 99 })]);
  const s = scanTotals(f, { fromOffset: 0 });
  assert.equal(s.totals.outputTokens, 114);
  assert.equal(s.totals.messages, 3);
});

// ── subagents are half the session ──────────────────────────────────────────
test("subagentDir points at the sibling tree, not a sibling file", () => {
  // the extension is dropped and "subagents" appended — the rest of the path is left
  // exactly as given, so a caller's separators survive untouched
  assert.equal(subagentDir("/p/abc.jsonl"), "/p/abc" + path.sep + "subagents");
  assert.equal(subagentDir("/p/ABC.JSONL"), "/p/ABC" + path.sep + "subagents", "extension match is case-insensitive");
  assert.equal(subagentDir(null), null);
});

test("a session with no subagents yields zeros, not a throw", () => {
  const lonely = write([rec({ id: "m", out: 1, cacheRead: 1 })]);
  const r = scanSubagents(lonely);
  assert.equal(r.fileCount, 0);
  assert.equal(r.totals.outputTokens, 0);
  assert.equal(r.totals.messages, 0);
});

test("a subagent tree counts toward totals but never toward context", () => {
  // Cost aggregates; context does not. A subagent's tokens never occupied THIS agent's
  // window, so a 999,999-token subagent read must leave ctxUsed exactly where it was.
  const main = write([rec({ id: "m1", input: 5, out: 50, cacheRead: 1000, cacheCreate: 20 })]);
  writeSub(main, "a.jsonl", [rec({ id: "s1", input: 7, out: 500, cacheRead: 999999, cacheCreate: 30 })]);
  writeSub(main, path.join("deep", "nested", "b.jsonl"), [rec({ id: "s2", input: 1, out: 200, cacheRead: 5 })]);

  const s = sample({ transcriptPath: main, windowTokens: 10000 });

  // totals means the WHOLE session — parent plus every subagent
  assert.equal(s.totals.outputTokens, 750);
  assert.equal(s.totals.inputTokens, 13);
  assert.equal(s.totals.messages, 3);
  assert.equal(s.sub.fileCount, 2, "the walk is recursive — the nested file counts");

  // and the split stays available
  assert.equal(s.mainTotals.outputTokens, 50);
  assert.equal(s.subagentTotals.outputTokens, 700);

  // context is the parent prompt alone
  assert.equal(s.ctxUsed, 1025, "5 + 1000 + 20 from the parent, and nothing from subagents");
  assert.equal(s.ctxPct, 10.3);
  assert.equal(s.windowExceeded, false);
});

test("subagents can be switched off, and then totals is the parent alone", () => {
  const main = write([rec({ id: "m1", out: 50, cacheRead: 10 })]);
  writeSub(main, "a.jsonl", [rec({ id: "s1", out: 500 })]);

  const s = sample({ transcriptPath: main, includeSubagents: false });
  assert.equal(s.totals.outputTokens, 50);
  assert.deepEqual(s.totals, s.mainTotals);
  assert.equal(s.subagentTotals, null);
  assert.equal(s.sub, null);
  assert.equal(s.subagentShare, null);
});

test("cost is estimated on the combined figure — subagent spend is spend", () => {
  const main = write([rec({ id: "m", input: 500_000 })]);
  writeSub(main, "a.jsonl", [rec({ id: "s", input: 500_000 })]);
  const s = sample({ transcriptPath: main, price: PRICES["opus-5-standard"] });
  assert.equal(s.costUsd, 5, "1M input @ $5 — half of it spent by the subagent");
  assert.equal(s.subagentShare, 0, "no output tokens either side, so the share is 0, not NaN");
});

test("subagentShare is the subagent slice of output tokens", () => {
  const half = write([rec({ id: "m", out: 51, cacheRead: 1 })]);
  writeSub(half, "a.jsonl", [rec({ id: "s", out: 49 })]);
  assert.equal(sample({ transcriptPath: half }).subagentShare, 49, "the measured real-session figure");

  const heavy = write([rec({ id: "m", out: 300, cacheRead: 1 })]);
  writeSub(heavy, "a.jsonl", [rec({ id: "s1", out: 400 })]);
  writeSub(heavy, path.join("x", "b.jsonl"), [rec({ id: "s2", out: 300 })]);
  assert.equal(sample({ transcriptPath: heavy }).subagentShare, 70);
});

test("a growing subagent file resumes without re-adding its streaming message", () => {
  const main = write([rec({ id: "m", out: 1, cacheRead: 1 })]);
  const sub = writeSub(main, "a.jsonl", [rec({ id: "s1", out: 100 })]);

  const first = scanSubagents(main);
  assert.equal(first.totals.outputTokens, 100);

  // s1 keeps streaming: a newer cumulative snapshot of the SAME message
  fs.appendFileSync(sub, rec({ id: "s1", out: 400 }) + "\n");
  const second = scanSubagents(main, { prevFiles: first.files });
  assert.equal(second.totals.outputTokens, 400, "500 would mean prevMessage is not threaded through");
  assert.equal(second.totals.messages, 1);

  // then a genuinely new message
  fs.appendFileSync(sub, rec({ id: "s2", out: 30 }) + "\n");
  const third = scanSubagents(main, { prevFiles: second.files });
  assert.equal(third.totals.outputTokens, 430);
  assert.equal(third.totals.messages, 2);
  assert.deepEqual(third.totals, scanSubagents(main).totals, "resumed must match a fresh full scan");
});

test("a subagent file that shrank rescans itself from zero", () => {
  const main = write([rec({ id: "m", out: 1, cacheRead: 1 })]);
  const sub = writeSub(main, "a.jsonl", [rec({ id: "s1", out: 100 }), rec({ id: "s2", out: 200 })]);

  const first = scanSubagents(main);
  assert.equal(first.totals.outputTokens, 300);

  fs.writeFileSync(sub, rec({ id: "s9", out: 7 }) + "\n");     // rotated to something smaller
  const second = scanSubagents(main, { prevFiles: first.files });
  assert.equal(second.totals.outputTokens, 7);
  assert.equal(second.totals.messages, 1);
  assert.deepEqual(second.totals, scanSubagents(main).totals);
});

test("a same-size subagent file with a newer mtime rescans instead of under-counting", () => {
  // The case a bare offset check cannot see: the file was replaced, its length happens to
  // match, and the stale offset already sits at EOF — so an offset-only resume reads zero
  // new bytes and confidently reports the OLD total forever.
  const main = write([rec({ id: "m", out: 1, cacheRead: 1 })]);
  const sub = writeSub(main, "a.jsonl", [rec({ id: "s1", out: 100 })]);

  const first = scanSubagents(main);
  assert.equal(first.totals.outputTokens, 100);
  assert.equal(first.files[sub].offset, first.files[sub].size, "offset is at EOF — nothing left to read");

  // replaced by different content of identical length, written later
  fs.writeFileSync(sub, rec({ id: "s2", out: 200 }) + "\n");
  assert.equal(fs.statSync(sub).size, first.files[sub].size, "fixture must actually be the same size");
  fs.utimesSync(sub, new Date(), new Date(first.files[sub].mtimeMs + 5000));

  const second = scanSubagents(main, { prevFiles: first.files });
  assert.equal(second.totals.outputTokens, 200, "reporting 100 here is the silent under-count");
  assert.equal(second.totals.messages, 1);
});

test("a subagent scan with unusable prior state still equals a full scan", () => {
  // garbage in prevFiles must degrade to a rescan, never to a wrong number
  const main = write([rec({ id: "m", out: 1, cacheRead: 1 })]);
  const sub = writeSub(main, "a.jsonl", [rec({ id: "s1", out: 100 }), rec({ id: "s2", out: 250 })]);
  const truth = scanSubagents(main).totals;

  for (const bad of [{}, { offset: 999999 }, { offset: -1, totals: {} }, { offset: 0, totals: null, size: 0 }]) {
    const r = scanSubagents(main, { prevFiles: { [sub]: bad } });
    assert.deepEqual(r.totals, truth, `bad prior state produced a wrong total: ${JSON.stringify(bad)}`);
  }
});

// ── the end-to-end invariant ─────────────────────────────────────────────────
test("a resumed sample equals a fresh one, main and subagents together", () => {
  // sampling fires on every tool call, so it must not drift from a cold read
  const main = tmpFile();
  fs.writeFileSync(main, rec({ id: "m1", input: 1, out: 10, cacheRead: 100 }) + "\n");
  const sub = writeSub(main, "a.jsonl", [rec({ id: "s1", out: 100 })]);

  const a = sample({ transcriptPath: main });
  assert.equal(a.totals.outputTokens, 110);

  // both sides advance: each finishes a message that was mid-stream, and the tree grows
  fs.appendFileSync(main, rec({ id: "m1", input: 1, out: 40, cacheRead: 100 }) + "\n");
  fs.appendFileSync(sub, rec({ id: "s1", out: 250 }) + "\n");
  writeSub(main, path.join("deep", "b.jsonl"), [rec({ id: "s2", out: 60 })]);

  const b = sample({ transcriptPath: main, prev: a });
  assert.deepEqual(b.totals, sample({ transcriptPath: main }).totals, "resumed must match a fresh sample");
  assert.equal(b.totals.outputTokens, 350, "40 main + 250 + 60 subagent");
  assert.equal(b.mainTotals.outputTokens, 40);
  assert.equal(b.subagentTotals.outputTokens, 310);
  assert.equal(b.totals.messages, 3);
});
