// The status line. This is the only surface that receives cost and context usage —
// hooks never do. Field names verified against the Claude Code binary, 2026-07-30:
//
//   context_window : { context_window_size, current_usage, used_percentage, remaining_percentage }
//   session        : { total_cost_usd, total_lines_added, total_lines_removed,
//                      model_usage, total_duration_ms, total_api_duration_ms }
//   subscription_type, rate_limits, exceeds_200k_tokens
//
// Every read is guarded. A status line that throws is a status line that breaks the
// user's prompt, so this function must always return a string.

/** Pull the fields we care about out of a status-line payload. */
export function parsePayload(p) {
  const cw = p?.context_window ?? {};
  let ctxPct = Number(cw.used_percentage);
  if (!Number.isFinite(ctxPct) && Number.isFinite(Number(cw.remaining_percentage))) {
    ctxPct = 100 - Number(cw.remaining_percentage);
  }
  if (!Number.isFinite(ctxPct)) ctxPct = 0;

  const s = p?.session ?? {};
  const dir = p?.workspace?.current_dir ?? p?.cwd ?? "";

  return {
    ctxPct: Math.max(0, Math.min(100, Math.round(ctxPct * 100) / 100)),
    ctxUsed: Number(cw.current_usage) || 0,
    ctxSize: Number(cw.context_window_size) || 0,
    costUsd: Math.round((Number(s.total_cost_usd) || 0) * 10000) / 10000,
    linesAdded: Number(s.total_lines_added) || 0,
    linesRemoved: Number(s.total_lines_removed) || 0,
    model: p?.model?.display_name || p?.model?.id || "agent",
    plan: p?.subscription_type || "",
    dir: dir ? dir.replace(/[/\\]+$/, "").split(/[/\\]/).pop() : "",
    over200k: Boolean(p?.exceeds_200k_tokens),
  };
}

const BARS = 10;

/** Render the one-line readout. Plain text — the host decides how to colour it. */
export function formatLine(h, { now = new Date() } = {}) {
  const fill = Math.min(BARS, Math.max(0, Math.round((h.ctxPct / 100) * BARS)));
  const meter = "#".repeat(fill) + ".".repeat(BARS - fill);

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");

  const parts = [`${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][now.getDay()]} ${hh}:${mm}`];
  if (h.dir) parts.push(h.dir);
  if (h.branch) parts.push(`(${h.branch})`);
  parts.push(h.model);
  parts.push(`ctx [${meter}] ${Math.round(h.ctxPct)}%`);
  parts.push(`$${h.costUsd.toFixed(2)}`);
  if (h.linesAdded || h.linesRemoved) parts.push(`+${h.linesAdded}/-${h.linesRemoved}`);
  if (h.ctxPct >= 85) parts.push("STOP: start a new window");

  return parts.join("  |  ");
}
