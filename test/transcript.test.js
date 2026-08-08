// Transcript-reader tests. Everything runs against fixtures written into a temp dir —
// no real transcript is read, so these are safe and deterministic.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-tx-test-"));
process.env.FOREMAN_HOME = path.join(sandbox, "home");
process.env.FOREMAN_CLAUDE_SETTINGS = path.join(sandbox, "claude", "settings.json");

const { sample, findTranscript, projectDir, tailUsage, scanTotals, promptTokens,
        estimateCost, PRICES } = await import("../src/transcript.js");

let n = 0;
const tmpFile = () => path.join(sandbox, `t${++n}.jsonl`);

/** One assistant record with the usage shape Claude Code actually writes. */
function rec({ input = 0, out = 0, cacheRead = 0, cacheCreate = 0, model = "claude-opus-5", ts = "2026-07-30T18:00:00.000Z" } = {}) {
  return JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: {
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

// ── token math ──────────────────────────────────────────────────────────────
test("promptTokens counts everything that occupied the window", () => {
  // fresh input + what was read from cache + what was written to it — cache reads are
  // the bulk of a long session and omitting them understates usage enormously
  assert.equal(promptTokens({ input_tokens: 2, cache_read_input_tokens: 285514, cache_creation_input_tokens: 2771 }), 288287);
  assert.equal(promptTokens({}), 0);
});

test("tailUsage returns the most recent record, not the first", () => {
  const f = write([rec({ out: 1, cacheRead: 100 }), rec({ out: 2, cacheRead: 200 }), rec({ out: 3, cacheRead: 300 })]);
  const u = tailUsage(f);
  assert.equal(u.outputTokens, 3);
  assert.equal(u.promptTokens, 300);
  assert.equal(u.model, "claude-opus-5");
});

test("tailUsage skips records with no usage", () => {
  const f = write([rec({ out: 5, cacheRead: 50 }), JSON.stringify({ type: "user", message: { content: "hi" } })]);
  assert.equal(tailUsage(f).outputTokens, 5);
});

test("tailUsage survives a half-written final line", () => {
  const f = tmpFile();
  fs.writeFileSync(f, rec({ out: 7, cacheRead: 70 }) + "\n" + '{"type":"assistant","mess');
  assert.equal(tailUsage(f).outputTokens, 7);
});

test("tailUsage discards a partial first line when reading only the tail", () => {
  // a small window forces a mid-line start; that fragment must not be parsed as a record
  const f = write([rec({ out: 1, cacheRead: 111111 }), rec({ out: 2, cacheRead: 222222 })]);
  const u = tailUsage(f, { bytes: 120 });
  assert.ok(u === null || u.outputTokens === 2, "must return the last record or nothing, never garbage");
});

test("tailUsage returns null on a missing file", () => {
  assert.equal(tailUsage(path.join(sandbox, "nope.jsonl")), null);
});

// ── incremental scanning ────────────────────────────────────────────────────
test("an incremental scan equals a full scan", () => {
  // the invariant the whole design rests on: sampling every tool call must not drift
  const first = [rec({ input: 1, out: 10, cacheRead: 100, cacheCreate: 5 }),
                 rec({ input: 2, out: 20, cacheRead: 200, cacheCreate: 6 })];
  const f = write(first);
  const a = scanTotals(f, { fromOffset: 0 });
  assert.equal(a.totals.messages, 2);
  assert.equal(a.totals.outputTokens, 30);

  fs.appendFileSync(f, rec({ input: 3, out: 30, cacheRead: 300, cacheCreate: 7 }) + "\n");
  const b = scanTotals(f, { fromOffset: a.offset, prevTotals: a.totals });
  const full = scanTotals(f, { fromOffset: 0 });

  assert.deepEqual(b.totals, full.totals, "incremental must match a fresh full scan");
  assert.equal(b.totals.outputTokens, 60);
  assert.equal(b.totals.messages, 3);
});

test("a record still being written is not double counted", () => {
  const f = write([rec({ out: 10 })]);
  const a = scanTotals(f, { fromOffset: 0 });
  fs.appendFileSync(f, rec({ out: 99 }).slice(0, 40));   // partial, no newline
  const b = scanTotals(f, { fromOffset: a.offset, prevTotals: a.totals });
  assert.equal(b.totals.outputTokens, 10, "partial record counted early");

  // now complete that record
  fs.writeFileSync(f, [rec({ out: 10 }), rec({ out: 99 })].join("\n") + "\n");
  const c = scanTotals(f, { fromOffset: b.offset, prevTotals: b.totals });
  assert.equal(c.totals.outputTokens, 109, "completed record never counted");
});

test("a shrunken file resets instead of producing nonsense", () => {
  const f = write([rec({ out: 10 }), rec({ out: 20 })]);
  const a = scanTotals(f, { fromOffset: 0 });
  fs.writeFileSync(f, rec({ out: 5 }) + "\n");            // rotated / new session
  const b = scanTotals(f, { fromOffset: a.offset, prevTotals: a.totals });
  assert.ok(b.reset);
  assert.equal(b.totals.outputTokens, 5);
});

// ── the window is an assertion, not a measurement ───────────────────────────
test("no window means no percentage, rather than a made-up one", () => {
  const f = write([rec({ cacheRead: 500 })]);
  const s = sample({ transcriptPath: f });
  assert.equal(s.ctxPct, null);
  assert.equal(s.ctxUsed, 500);
  assert.equal(s.windowExceeded, false);
});

test("usage past the assumed window is flagged, never clamped", () => {
  // this is the real bug: 305,569 tokens displayed as 55% of a 200,000 window
  const f = write([rec({ cacheRead: 305569 })]);
  const s = sample({ transcriptPath: f, windowTokens: 200000, windowSource: "test" });
  assert.equal(s.windowExceeded, true);
  assert.ok(s.ctxPct > 100, `expected >100%, got ${s.ctxPct}`);
  assert.equal(s.windowSource, "test");

  const ok = sample({ transcriptPath: f, windowTokens: 1000000 });
  assert.equal(ok.windowExceeded, false);
  assert.equal(ok.ctxPct, 30.6);
});

// ── cost is estimated and always labelled ───────────────────────────────────
test("no price means no cost, not a zero", () => {
  const f = write([rec({ input: 100, out: 200, cacheRead: 5000 })]);
  const s = sample({ transcriptPath: f });
  assert.equal(s.costUsd, null);
  assert.equal(s.costBasis, null);
  assert.equal(estimateCost({ inputTokens: 1 }, null), null);
});

test("a supplied price produces a labelled estimate that excludes cache reads", () => {
  const f = write([rec({ input: 1_000_000, out: 1_000_000, cacheRead: 9_999_999 })]);
  const s = sample({ transcriptPath: f, price: PRICES["opus-5-fast"] });
  assert.equal(s.costUsd, 60);                       // 1M in @ $10 + 1M out @ $50
  assert.match(s.costBasis.source, /anthropic-latest/);
  assert.equal(s.costBasis.excludesCacheReads, 9_999_999);
});

test("the standard rate is the standard rate, not the fast-mode premium", () => {
  // Billing the fast premium to an ordinary session overstates it 2x. The two
  // presets must stay distinct, and neither may silently become the other.
  const f = write([rec({ input: 1_000_000, out: 1_000_000, cacheRead: 9_999_999 })]);
  const s = sample({ transcriptPath: f, price: PRICES["opus-5-standard"] });
  assert.equal(s.costUsd, 30);                       // 1M in @ $5 + 1M out @ $25
  assert.match(s.costBasis.source, /\d{4}-\d{2}-\d{2}/);
  assert.equal(s.costBasis.excludesCacheReads, 9_999_999);

  const fast = sample({ transcriptPath: f, price: PRICES["opus-5-fast"] });
  assert.equal(fast.costUsd, 60);
  assert.ok(fast.costUsd > s.costUsd, "fast mode is the premium, not the default");
});

test("every price preset carries a source and a date", () => {
  // an unsourced rate is how a confident wrong number gets shipped
  for (const [name, p] of Object.entries(PRICES)) {
    assert.ok(p.source && /\d{4}-\d{2}-\d{2}/.test(p.source), `${name} has no dated source`);
    assert.ok(Number.isFinite(p.input) && Number.isFinite(p.output), `${name} has no rates`);
  }
});

// ── locating the file ───────────────────────────────────────────────────────
test("an explicit transcript path wins", () => {
  const f = write([rec({ out: 1 })]);
  assert.equal(findTranscript({ transcriptPath: f }), f);
});

test("a bad explicit path falls back rather than throwing", () => {
  assert.doesNotThrow(() => findTranscript({ transcriptPath: path.join(sandbox, "ghost.jsonl"), cwd: sandbox, home: sandbox }));
});

test("projectDir slugifies the working directory the way Claude Code does", () => {
  assert.equal(projectDir("C:\\Users\\whitt", "H"), path.join("H", ".claude", "projects", "C--Users-whitt"));
});

test("sample returns null when there is no transcript at all", () => {
  const empty = fs.mkdtempSync(path.join(sandbox, "empty-"));
  assert.equal(sample({ cwd: empty, home: empty }), null);
});

test("a transcript with no usage records yields null", () => {
  const f = write([JSON.stringify({ type: "user", message: { content: "hi" } })]);
  assert.equal(sample({ transcriptPath: f }), null);
});

// ── the shape the HUD consumes ──────────────────────────────────────────────
test("a sample is shaped like a HUD reading and says where it came from", () => {
  const f = write([rec({ input: 5, out: 50, cacheRead: 1000, cacheCreate: 20 })]);
  const s = sample({ transcriptPath: f, windowTokens: 10000 });
  assert.equal(s.src, "transcript");
  assert.equal(s.ctxUsed, 1025);
  assert.equal(s.ctxPct, 10.3);
  assert.equal(s.model, "claude-opus-5");
  assert.ok(s.tx.file && Number.isFinite(s.tx.offset));
  assert.equal(s.totals.messages, 1);
});
