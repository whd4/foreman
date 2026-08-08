// How badly does transcript-only token accounting undercount, across a real corpus?
//
// RUN ONLY WITH A VALIDATED COUNTER. The first version of this study was executed while
// scanTotals still summed streaming snapshots (2.65x overcount) and every figure had to
// be retracted. verify-dedup.mjs must pass before this means anything.
//
// Method: for each <session>.jsonl, sum deduped usage from the main transcript, then the
// same from every .jsonl under the sibling <session>/subagents/ tree. The undercount is
// what a transcript-only instrument misses.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanTotals, scanSubagents } from "./src/index.js";

// Defaults to whoever is running it; override with an explicit path.
// A corpus study hardcoded to one person's disk is an anecdote, not a study.
const PROJECTS = process.argv[2] ?? path.join(os.homedir(), ".claude", "projects");

function sessionsIn(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sessionsIn(full, out);
    else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

const rows = [];
for (const file of sessionsIn(PROJECTS)) {
  // Skip subagent transcripts themselves - counted via their parent session.
  if (file.includes(`${path.sep}subagents${path.sep}`)) continue;

  let size = 0;
  try { size = fs.statSync(file).size; } catch { continue; }
  if (size < 2000) continue;

  const { totals } = scanTotals(file, { fromOffset: 0 });
  if (!totals.messages) continue;

  const sub = scanSubagents(file);
  const mainOut = totals.outputTokens ?? 0;
  const subOut = sub.totals.outputTokens ?? 0;
  const allOut = mainOut + subOut;

  rows.push({
    id: path.basename(file, ".jsonl").slice(0, 8),
    mainOut, subOut, allOut,
    subFiles: sub.fileCount,
    share: allOut > 0 ? (subOut / allOut) * 100 : 0,
    msgsMain: totals.messages,
    msgsSub: sub.totals.messages ?? 0,
  });
}

rows.sort((a, b) => b.share - a.share);

const n = (x) => Math.round(x).toLocaleString();
const withSub = rows.filter(r => r.subOut > 0);

console.log("=== CORPUS ===");
console.log("  sessions with usage records :", rows.length);
console.log("  sessions that spawned agents:", withSub.length,
            "(" + Math.round((withSub.length / Math.max(rows.length, 1)) * 100) + "%)");
console.log();

const totMain = rows.reduce((s, r) => s + r.mainOut, 0);
const totSub  = rows.reduce((s, r) => s + r.subOut, 0);
console.log("=== AGGREGATE OUTPUT TOKENS (deduped) ===");
console.log("  counted by transcript-only :", n(totMain));
console.log("  missed (subagents)         :", n(totSub));
console.log("  true total                 :", n(totMain + totSub));
console.log("  UNDERCOUNT                 :",
  (totMain + totSub > 0 ? ((totSub / (totMain + totSub)) * 100).toFixed(1) : "0") + "% of all output tokens invisible");
console.log();

if (withSub.length) {
  const shares = withSub.map(r => r.share).sort((a, b) => a - b);
  const pct = (p) => shares[Math.min(shares.length - 1, Math.floor((p / 100) * shares.length))];
  console.log("=== DISTRIBUTION (sessions that actually used agents, n=" + withSub.length + ") ===");
  console.log("  min    :", shares[0].toFixed(1) + "%");
  console.log("  median :", pct(50).toFixed(1) + "%");
  console.log("  p90    :", pct(90).toFixed(1) + "%");
  console.log("  max    :", shares[shares.length - 1].toFixed(1) + "%");
  console.log();
  const subMain = withSub.reduce((s, r) => s + r.mainOut, 0);
  const subSub  = withSub.reduce((s, r) => s + r.subOut, 0);
  console.log("  aggregate across agent-using sessions:",
    ((subSub / (subMain + subSub)) * 100).toFixed(1) + "% invisible");
  console.log();
  console.log("=== WORST 10 ===");
  console.log("  session   subagent%   missed out tok   sub files");
  withSub.slice(0, 10).forEach(r => {
    console.log("  " + r.id.padEnd(10) + (r.share.toFixed(1) + "%").padStart(8)
      + n(r.subOut).padStart(16) + String(r.subFiles).padStart(11));
  });
}
