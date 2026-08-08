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
  "opus-5-standard": {
    input: 5, output: 25,
    label: "Opus 5, standard",
    source: "platform.claude.com/docs/en/about-claude/models/overview.md, read 2026-08-07",
    note: "Standard tier — the rate an ordinary session bills at. Fast mode is a premium; see opus-5-fast.",
  },
  "opus-5-fast": {
    input: 10, output: 50,
    label: "Opus 5, fast mode",
    source: "~/.claude/anthropic-latest.md, read 2026-07-30",
    note: "FAST mode only, which is billed at a premium. If you are not running fast mode, opus-5-standard is your rate.",
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

const EMPTY_TOTALS = Object.freeze({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, messages: 0,
});

/** The four usage fields off one record, as plain numbers. */
function usageNumbers(u) {
  return {
    inputTokens:       Number(u.input_tokens) || 0,
    outputTokens:      Number(u.output_tokens) || 0,
    cacheReadTokens:   Number(u.cache_read_input_tokens) || 0,
    cacheCreateTokens: Number(u.cache_creation_input_tokens) || 0,
  };
}

/**
 * Accumulate totals over records added since `fromOffset`.
 *
 * ONE RECORD IS NOT ONE MESSAGE. Claude writes MULTIPLE JSONL records for a single
 * assistant message as it streams, each carrying a CUMULATIVE usage snapshot — the same
 * `message.id` appearing with output_tokens 2, then 900, then 2047. Summing every record
 * therefore counts the same tokens over and over.
 *
 * Measured on a live 3.5 MB transcript, 2026-08-02: 620 usage records but only 273 unique
 * message ids, 184 of them duplicated. Naive sum 788,424 output tokens; correct total
 * 296,971. A 2.65x overcount, present since this file was written and invisible because
 * the number merely looked large rather than wrong.
 *   [found by an independent cross-vendor review, then reproduced here before accepting]
 *
 * The fix: keep the LAST snapshot per message. Because snapshots for one message arrive
 * contiguously, carrying only the previous id and what it contributed is enough — when
 * the same id reappears, its earlier contribution is backed out and replaced. That keeps
 * the scan O(new bytes) and, critically, keeps it correct ACROSS incremental resumes:
 * `prev.lastId` / `prev.lastCounted` let a later sample finish a message that was still
 * streaming when the previous sample stopped.
 */
export function scanTotals(file, { fromOffset = 0, prevTotals = null, prevMessage = null } = {}) {
  const empty = { ...EMPTY_TOTALS };
  let fd, size;
  try {
    fd = fs.openSync(file, "r");
    size = fs.fstatSync(fd).size;
  } catch { return { totals: { ...empty }, offset: 0, reset: true, message: null }; }

  let start = fromOffset;
  let totals = prevTotals ? { ...empty, ...prevTotals } : { ...empty };
  // The message that was mid-stream when we last stopped, and what it had contributed.
  let lastId = prevMessage?.id ?? null;
  let lastCounted = prevMessage?.counted ?? null;
  let reset = false;
  if (!Number.isFinite(start) || start < 0 || start > size) {
    start = 0; totals = { ...empty }; lastId = null; lastCounted = null; reset = true;
  }

  try {
    if (size === start) {
      return { totals, offset: size, reset, message: lastId ? { id: lastId, counted: lastCounted } : null };
    }
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString("utf8");

    const lines = text.split("\n");
    // The final element is whatever follows the last newline — possibly a half-written
    // record. Leave it unconsumed so the next sample picks it up whole.
    const tailFragment = lines.pop() ?? "";
    let anon = 0;
    for (const raw of lines) {
      const rec = parseLine(raw.replace(/\r$/, ""));
      const u = usageOf(rec);
      if (!u) continue;
      const n = usageNumbers(u);
      // A record with no id cannot be de-duplicated, so treat each as its own message.
      const id = rec?.message?.id ?? ` anon-${start}-${anon++}`;

      if (id === lastId && lastCounted) {
        // Newer snapshot of the SAME message: replace, do not add. Deltas can be
        // negative if a provider ever reports a smaller figure; subtraction handles it.
        for (const k of Object.keys(EMPTY_TOTALS)) {
          if (k === "messages") continue;
          totals[k] += (n[k] ?? 0) - (lastCounted[k] ?? 0);
        }
        lastCounted = n;
      } else {
        for (const k of Object.keys(EMPTY_TOTALS)) {
          if (k === "messages") continue;
          totals[k] += n[k] ?? 0;
        }
        totals.messages += 1;
        lastId = id;
        lastCounted = n;
      }
    }
    return {
      totals,
      offset: size - Buffer.byteLength(tailFragment, "utf8"),
      reset,
      message: lastId ? { id: lastId, counted: lastCounted } : null,
    };
  } catch {
    return { totals, offset: start, reset, message: lastId ? { id: lastId, counted: lastCounted } : null };
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

/**
 * Where a session's subagent transcripts live.
 *
 * Claude Code writes the main session to `<project>/<session-id>.jsonl` and every
 * subagent to `<project>/<session-id>/subagents/**\/*.jsonl` — a sibling TREE, not a
 * sibling file. Scanning only the main transcript therefore misses every token a
 * subagent spends.
 *
 * That is not a rounding error. Measured in a live session on 2026-08-02: main
 * transcript 3.55 MB, subagent tree 3.40 MB — 49% of all activity, and 604k+ tokens
 * across two workflow runs, none of it visible. For an instrument whose entire purpose
 * is showing what agents cost, being blind to agent spend defeats the thesis: the HUD
 * reads calm while real burn is roughly double.
 */
export function subagentDir(mainFile) {
  if (!mainFile) return null;
  return mainFile.replace(/\.jsonl$/i, "") + path.sep + "subagents";
}

/** Every .jsonl under a directory, recursively. Returns [] rather than throwing. */
function walkJsonl(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkJsonl(full, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/**
 * Totals across every subagent transcript for this session.
 *
 * Incremental exactly like scanTotals, but per file: `prevOffsets` maps path -> byte
 * offset, so a session with 200 subagent files still costs one stat + one short read per
 * file per sample. A file that shrank or vanished resets itself alone, never the whole set.
 */
export function scanSubagents(mainFile, { prevFiles = {} } = {}) {
  const empty = { ...EMPTY_TOTALS };
  const dir = subagentDir(mainFile);
  const result = { totals: { ...empty }, files: {}, fileCount: 0, bytes: 0 };
  if (!dir || !fs.existsSync(dir)) return result;

  for (const f of walkJsonl(dir)) {
    let size = 0, mtimeMs = 0;
    try { const st = fs.statSync(f); size = st.size; mtimeMs = st.mtimeMs; } catch { continue; }
    result.fileCount += 1;
    result.bytes += size;

    const prev = prevFiles[f];
    // Resume ONLY from a complete prior record whose file has grown from a known size.
    // Anything else — missing totals, a shrunk file, or a same-size replacement with a
    // newer mtime — rescans that one file from zero. Cheap, and it cannot silently
    // under-count. A bare offset check cannot detect a same-size replacement at all.
    const usable = prev
      && Number.isFinite(prev.offset) && prev.offset >= 0 && prev.offset <= size
      && prev.totals && typeof prev.totals === "object"
      && Number.isFinite(prev.size) && size >= prev.size
      && !(size === prev.size && Number.isFinite(prev.mtimeMs) && mtimeMs > prev.mtimeMs);

    const { totals, offset, message } = scanTotals(f, {
      fromOffset: usable ? prev.offset : 0,
      prevTotals: usable ? prev.totals : null,
      prevMessage: usable ? prev.message : null,
    });

    result.files[f] = { offset, totals, size, mtimeMs, message };
    for (const k of Object.keys(empty)) result.totals[k] += totals[k] ?? 0;
  }
  return result;
}

/**
 * One reading, shaped like the HUD so it can replace the status line.
 *
 * `windowTokens` is an ASSERTION, not a measurement. Pass what you believe the window to
 * be; the result records where that belief came from and flags it when usage exceeds it.
 *
 * WHAT `totals` MEANS: the WHOLE session — parent plus every subagent. That is what a
 * person means by "what did this cost", and it is what every existing display reads. An
 * earlier attempt put the subagent numbers in a new `combined` field and left `totals`
 * parent-only; the library was then correct while `fmn sample`, the watch HUD and
 * multi-session aggregation all still showed the undercount. A fix nothing reads is not
 * a fix. [cross-vendor review, 2026-08-02]
 *
 * `mainTotals` and `subagentTotals` remain available for anyone who needs the split.
 *
 * Context is the one thing that must NOT be combined: `ctxUsed`/`ctxPct` come solely from
 * the latest parent prompt, because a subagent's tokens never occupied this agent's
 * window. Cost aggregates; context does not.
 */
export function sample({
  transcriptPath,
  cwd = process.cwd(),
  home = os.homedir(),
  windowTokens = null,
  windowSource = null,
  price = null,
  prev = null,
  includeSubagents = true,
} = {}) {
  const file = findTranscript({ transcriptPath, cwd, home });
  if (!file) return null;

  const head = tailUsage(file);
  if (!head) return null;

  const sameFile = prev?.tx?.file === file;
  const { totals: mainTotals, offset, reset, message } = scanTotals(file, {
    fromOffset: sameFile ? prev?.tx?.offset ?? 0 : 0,
    prevTotals: sameFile ? prev?.tx?.totals : null,
    prevMessage: sameFile ? prev?.tx?.message : null,
  });

  const sub = includeSubagents
    ? scanSubagents(file, { prevFiles: sameFile ? prev?.sub?.files ?? {} : {} })
    : null;

  const subTotals = sub ? sub.totals : { ...EMPTY_TOTALS };

  // The session figure. This is `totals` because it is what every consumer means.
  const totals = {
    inputTokens:       (mainTotals.inputTokens       ?? 0) + (subTotals.inputTokens       ?? 0),
    outputTokens:      (mainTotals.outputTokens      ?? 0) + (subTotals.outputTokens      ?? 0),
    cacheReadTokens:   (mainTotals.cacheReadTokens   ?? 0) + (subTotals.cacheReadTokens   ?? 0),
    cacheCreateTokens: (mainTotals.cacheCreateTokens ?? 0) + (subTotals.cacheCreateTokens ?? 0),
    messages:          (mainTotals.messages          ?? 0) + (subTotals.messages          ?? 0),
  };

  const used = head.promptTokens;
  const over = Number.isFinite(windowTokens) && windowTokens > 0 && used > windowTokens;
  const ctxPct = Number.isFinite(windowTokens) && windowTokens > 0
    ? Math.round((used / windowTokens) * 1000) / 10
    : null;

  // Cost is estimated on the COMBINED figure - subagent spend is spend.
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
    // `tx.totals` carries the PARENT-only running state, because that is what the
    // incremental resume needs. `message` carries the message that was mid-stream when
    // this scan stopped, so the next sample finishes it rather than re-adding it.
    tx: { file, offset, totals: mainTotals, message, size: head.fileSize, reset },

    // The split, for anyone who needs it. `totals` above is the combined session figure.
    mainTotals,
    subagentTotals: sub ? sub.totals : null,
    sub: sub ? { fileCount: sub.fileCount, bytes: sub.bytes, totals: sub.totals, files: sub.files } : null,

    // Share of output tokens spent by subagents. The headline number for how much a
    // transcript-only instrument would have missed on this session.
    subagentShare: (() => {
      if (!sub) return null;
      const m = mainTotals.outputTokens ?? 0, s = subTotals.outputTokens ?? 0;
      return m + s > 0 ? Math.round((s / (m + s)) * 1000) / 10 : 0;
    })(),
  };
}
