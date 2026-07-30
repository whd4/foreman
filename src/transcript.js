// Reading usage straight from the agent's own transcript.
//
// Why this exists: the status line is the ONLY surface that carries cost and context,
// and it does not fire reliably. Measured 2026-07-30 in a live Claude Code session —
// hooks fired 157 times while the status line fired 10 times and then stopped for 76
// minutes across two user turns. An instrument that freezes silently is worse than no
// instrument, because you keep trusting it.
//
// Hooks DO fire, every single tool call, and every hook payload carries
// `transcript_path`. The transcript is JSONL, one record per message, and assistant
// records carry `message.usage` with exact token counts. So the numbers are already on
// disk — they just were not being read.
//
// Two rules this file follows, both learned the hard way:
//
//   1. TOKENS ARE MEASURED, COST IS ESTIMATED. Token counts come from the transcript and
//      are exact. Cost needs a price table, which the transcript does not carry. So cost
//      is only ever reported when a price is supplied, and it is always labelled as an
//      estimate with its source. Never invent a rate.
//
//   2. THE WINDOW SIZE IS NOT DERIVABLE. The transcript says how many tokens were sent,
//      not how many were allowed. Claude Code's status line reported 200000 for a model
//      documented at 1M, which made a 288k-token prompt read as "55%" of a window it had
//      already outgrown. So a percentage is reported ONLY against a window size someone
//      asserted, and the assertion is labelled. When usage exceeds the assumed window,
//      that is surfaced as a contradiction rather than clamped to 100%.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** How much of the tail to read when we only need the most recent record. */
const TAIL_BYTES = 256 * 1024;

/**
 * Published prices, per million tokens. Each entry MUST carry its source and the date it
 * was read, because a stale price silently produces a confident wrong number.
 *
 * Deliberately sparse. Only rates actually verified against a source on disk are here;
 * everything else is absent so that asking for it fails loudly instead of guessing.
 */
export const PRICES = {
  "opus-5-fast": {
    input: 10, output: 50,
    label: "Opus 5, fast mode",
    source: "~/.claude/anthropic-latest.md, read 2026-07-30",
    note: "Documented for FAST mode. Standard-tier pricing is NOT this number and is not verified here.",
  },
};

/** Cache reads and cache writes are not billed at the input rate; without a verified
 *  multiplier we do not pretend to know one. Callers get the raw counts and decide. */
export function estimateCost(totals, price) {
  if (!price) return null;
  const inTok = (totals.inputTokens ?? 0) + (totals.cacheCreateTokens ?? 0);
  const outTok = totals.outputTokens ?? 0;
  return {
    usd: (inTok / 1e6) * price.input + (outTok / 1e6) * price.output,
    label: price.label,
    source: price.source,
    note: price.note,
    excludesCacheReads: totals.cacheReadTokens ?? 0,
  };
}

/** Claude Code's per-project transcript directory for a working directory. */
export function projectDir(cwd = process.cwd(), home = os.homedir()) {
  // Claude Code replaces EVERY non-alphanumeric character with a dash — one for one, not
  // one per run. `C:\Users\whitt` becomes `C--Users-whitt`: the colon and the backslash
  // each contribute a dash. Collapsing runs yields `C-Users-whitt`, which matches no
  // directory on disk, and the fallback lookup silently finds nothing.
  const slug = cwd.replace(/[\\/]+$/, "").replace(/[^A-Za-z0-9]/g, "-");
  return path.join(home, ".claude", "projects", slug);
}

/**
 * Locate a transcript. Prefers an explicit path (hook payloads carry `transcript_path`,
 * which is authoritative), then the newest .jsonl for this project.
 */
export function findTranscript({ transcriptPath, cwd = process.cwd(), home = os.homedir() } = {}) {
  if (transcriptPath && fs.existsSync(transcriptPath)) return transcriptPath;

  const dir = projectDir(cwd, home);
  let entries = [];
  try {
    entries = fs.readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const full = path.join(dir, f);
        try { return { full, mtime: fs.statSync(full).mtimeMs }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return null; }

  return entries.length ? entries[0].full : null;
}

/** Parse a line, returning null rather than throwing — the last line may be half-written. */
function parseLine(line) {
  if (!line || line[0] !== "{") return null;
  try { return JSON.parse(line); } catch { return null; }
}

function usageOf(rec) {
  const u = rec?.message?.usage;
  return u && typeof u === "object" ? u : null;
}

/**
 * Tokens occupying the window on the most recent API call. This is the prompt that was
 * actually sent: fresh input, plus what was read from cache, plus what was written to it.
 */
export function promptTokens(u) {
  return (Number(u.input_tokens) || 0)
       + (Number(u.cache_read_input_tokens) || 0)
       + (Number(u.cache_creation_input_tokens) || 0);
}

/**
 * Read only the tail for the newest usage record. O(1) in session length, which matters
 * because this runs on every tool call and transcripts reach tens of megabytes.
 */
export function tailUsage(file, { bytes = TAIL_BYTES } = {}) {
  let fd, size;
  try {
    fd = fs.openSync(file, "r");
    size = fs.fstatSync(fd).size;
  } catch { return null; }

  try {
    const start = Math.max(0, size - bytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString("utf8");
    // a partial first line is expected whenever we did not start at byte 0
    const lines = text.split(/\r?\n/);
    if (start > 0) lines.shift();

    for (let i = lines.length - 1; i >= 0; i--) {
      const rec = parseLine(lines[i]);
      const u = usageOf(rec);
      if (!u) continue;
      return {
        promptTokens: promptTokens(u),
        outputTokens: Number(u.output_tokens) || 0,
        cacheReadTokens: Number(u.cache_read_input_tokens) || 0,
        model: rec.message?.model ?? null,
        speed: u.speed ?? null,
        serviceTier: u.service_tier ?? null,
        at: rec.timestamp ?? null,
        fileSize: size,
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

/**
 * Accumulate totals over records added since `fromOffset`.
 * Incremental by byte offset, so a long session costs the same per sample as a short one.
 * A file that shrank (or a different file) resets rather than producing nonsense.
 */
export function scanTotals(file, { fromOffset = 0, prevTotals = null } = {}) {
  const empty = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, messages: 0 };
  let fd, size;
  try {
    fd = fs.openSync(file, "r");
    size = fs.fstatSync(fd).size;
  } catch { return { totals: { ...empty }, offset: 0, reset: true }; }

  let start = fromOffset;
  let totals = prevTotals ? { ...empty, ...prevTotals } : { ...empty };
  let reset = false;
  if (!Number.isFinite(start) || start < 0 || start > size) { start = 0; totals = { ...empty }; reset = true; }

  try {
    if (size === start) return { totals, offset: size, reset };
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString("utf8");

    const lines = text.split("\n");
    // The final element is whatever follows the last newline — possibly a half-written
    // record. Leave it unconsumed so the next sample picks it up whole.
    const tailFragment = lines.pop() ?? "";
    for (const raw of lines) {
      const u = usageOf(parseLine(raw.replace(/\r$/, "")));
      if (!u) continue;
      totals.inputTokens       += Number(u.input_tokens) || 0;
      totals.outputTokens      += Number(u.output_tokens) || 0;
      totals.cacheReadTokens   += Number(u.cache_read_input_tokens) || 0;
      totals.cacheCreateTokens += Number(u.cache_creation_input_tokens) || 0;
      totals.messages          += 1;
    }
    return { totals, offset: size - Buffer.byteLength(tailFragment, "utf8"), reset };
  } catch {
    return { totals, offset: start, reset };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

/**
 * One reading, shaped like the HUD so it can replace the status line.
 *
 * `windowTokens` is an ASSERTION, not a measurement. Pass what you believe the window to
 * be; the result records where that belief came from and flags it when usage exceeds it.
 */
export function sample({
  transcriptPath,
  cwd = process.cwd(),
  home = os.homedir(),
  windowTokens = null,
  windowSource = null,
  price = null,
  prev = null,
} = {}) {
  const file = findTranscript({ transcriptPath, cwd, home });
  if (!file) return null;

  const head = tailUsage(file);
  if (!head) return null;

  const sameFile = prev?.tx?.file === file;
  const { totals, offset, reset } = scanTotals(file, {
    fromOffset: sameFile ? prev?.tx?.offset ?? 0 : 0,
    prevTotals: sameFile ? prev?.tx?.totals : null,
  });

  const used = head.promptTokens;
  const over = Number.isFinite(windowTokens) && windowTokens > 0 && used > windowTokens;
  const ctxPct = Number.isFinite(windowTokens) && windowTokens > 0
    ? Math.round((used / windowTokens) * 1000) / 10
    : null;

  const cost = estimateCost(totals, price);

  return {
    src: "transcript",
    at: new Date().toISOString(),
    ctxUsed: used,
    ctxSize: windowTokens ?? null,
    ctxPct,
    // Loud on purpose: a percentage over 100 means the asserted window is wrong, and a
    // wrong window is exactly how "55%" got printed for a prompt that had outgrown it.
    windowExceeded: over,
    windowSource: windowSource ?? (windowTokens ? "asserted by caller" : null),
    model: head.model,
    speed: head.speed,
    serviceTier: head.serviceTier,
    lastMessageAt: head.at,
    totals,
    costUsd: cost ? Math.round(cost.usd * 10000) / 10000 : null,
    costBasis: cost ? { label: cost.label, source: cost.source, note: cost.note,
                        excludesCacheReads: cost.excludesCacheReads } : null,
    tx: { file, offset, totals, size: head.fileSize, reset },
  };
}
