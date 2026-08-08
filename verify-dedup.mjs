// Does the dedup fix produce the KNOWN-CORRECT number?
//
// Ground truth established independently in verify-codex-claim.mjs by parsing the whole
// transcript and taking the final snapshot per message.id:
//   naive (sum every record) : 788,424
//   correct (final per msg)  : 296,971   <- scanTotals must now produce this
//
// Validating the instrument BEFORE running a corpus study with it. Skipping that step is
// how the last set of published numbers had to be retracted.

import fs from "node:fs";
import { scanTotals } from "./src/index.js";

// The transcript to check, as an argument — this has to run on a machine that
// isn't the author's, or it proves nothing to anyone else.
const TX = process.argv[2];
if (!TX) {
  console.error("usage: node verify-dedup.mjs <path/to/session.jsonl>");
  console.error("  any Claude Code transcript with a streamed assistant message will do.");
  process.exit(1);
}

// --- independent ground truth, recomputed here rather than hardcoded ---
const byId = new Map();
let naive = 0, records = 0;
for (const line of fs.readFileSync(TX, "utf8").split("\n")) {
  if (!line || line[0] !== "{") continue;
  let rec; try { rec = JSON.parse(line); } catch { continue; }
  const u = rec?.message?.usage;
  if (!u) continue;
  records++;
  const out = Number(u.output_tokens) || 0;
  naive += out;
  byId.set(rec?.message?.id ?? `anon${records}`, out);   // last write wins = final snapshot
}
let truth = 0;
for (const v of byId.values()) truth += v;

// --- what scanTotals now reports ---
const full = scanTotals(TX, { fromOffset: 0 });

const n = (x) => x.toLocaleString();
console.log("=== DEDUP VERIFICATION ===");
console.log("  records in transcript   :", n(records));
console.log("  unique message ids      :", n(byId.size));
console.log();
console.log("  naive sum (old bug)     :", n(naive));
console.log("  ground truth (final/msg):", n(truth));
console.log("  scanTotals now reports  :", n(full.totals.outputTokens));
console.log("  messages now reports    :", n(full.totals.messages), "(should equal unique ids)");
console.log();
const outOk = full.totals.outputTokens === truth;
const msgOk = full.totals.messages === byId.size;
console.log("  output matches truth    :", outOk ? "PASS" : "FAIL");
console.log("  message count matches   :", msgOk ? "PASS" : "FAIL");

// --- incremental resume must equal a single full scan ---
const half = Math.floor(fs.statSync(TX).size / 2);
const a = scanTotals(TX, { fromOffset: 0, prevTotals: null, prevMessage: null });
const partial = scanTotals(TX, { fromOffset: 0 });
// simulate: scan to a midpoint, then resume
const first = (() => {
  const buf = fs.readFileSync(TX);
  const cut = buf.lastIndexOf(10, half) + 1;   // newline boundary
  const tmp = "verify-dedup-tmp.jsonl";
  fs.writeFileSync(tmp, buf.subarray(0, cut));
  const r = scanTotals(tmp, { fromOffset: 0 });
  fs.unlinkSync(tmp);
  return { r, cut };
})();
const resumed = scanTotals(TX, {
  fromOffset: first.r.offset,
  prevTotals: first.r.totals,
  prevMessage: first.r.message,
});
console.log();
console.log("=== INCREMENTAL RESUME ===");
console.log("  one full scan           :", n(full.totals.outputTokens));
console.log("  split scan then resume  :", n(resumed.totals.outputTokens));
const incOk = resumed.totals.outputTokens === full.totals.outputTokens
           && resumed.totals.messages === full.totals.messages;
console.log("  identical               :", incOk ? "PASS" : "FAIL  <- incremental path is wrong");

process.exit(outOk && msgOk && incOk ? 0 : 1);
