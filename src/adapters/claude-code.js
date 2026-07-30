// Claude Code adapter.
//
// This is the only code in the package that writes to a file the user owns, so:
//   1. it always backs up first
//   2. it MERGES into existing hooks rather than replacing them
//   3. it refuses to overwrite a status line someone else installed, unless forced
//   4. it is idempotent — running init twice does not double the hooks

import fs from "node:fs";
import { claudeSettings, backup, readJson, writeJson } from "../paths.js";

export const id = "claude-code";
export const label = "Claude Code";

/** Events we register, and nothing else. PostToolUse is included only to catch failures. */
export const HOOK_EVENTS = [
  "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse",
  "SubagentStop", "Notification", "PreCompact", "Stop",
];

const MARK = "foreman";
const isOurs = (cmd) => typeof cmd === "string" && cmd.includes(MARK);

function hookCommand(bin) { return `${bin} hook`; }
function statusCommand(bin) { return `${bin} status`; }

/** Resolve how the hook should invoke us. `foreman` on PATH once globally installed. */
export function resolveBin() {
  return process.env.FOREMAN_BIN || "foreman";
}

export function detect() {
  return fs.existsSync(claudeSettings());
}

/**
 * Install hooks + status line.
 * Returns { file, backup, added[], skipped[], statusLine, warnings[] } and writes nothing
 * when `dryRun` is set.
 */
export function install({ dryRun = false, force = false, bin = resolveBin() } = {}) {
  const file = claudeSettings();
  const settings = readJson(file, {}) ?? {};
  const warnings = [];
  const added = [];
  const skipped = [];

  if (!fs.existsSync(file)) warnings.push(`${file} did not exist — creating it`);

  settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};

  for (const evt of HOOK_EVENTS) {
    const list = Array.isArray(settings.hooks[evt]) ? settings.hooks[evt] : [];
    const present = list.some((g) => (g?.hooks ?? []).some((h) => isOurs(h?.command)));
    if (present) { skipped.push(evt); settings.hooks[evt] = list; continue; }

    const entry = { hooks: [{ type: "command", command: hookCommand(bin) }] };
    // PreToolUse / PostToolUse take a matcher; the others do not.
    if (evt === "PreToolUse" || evt === "PostToolUse") entry.matcher = "*";

    settings.hooks[evt] = [...list, entry];
    added.push(evt);
  }

  let statusLine = "unchanged";
  const existing = settings.statusLine;
  if (!existing) {
    settings.statusLine = { type: "command", command: statusCommand(bin) };
    statusLine = "installed";
  } else if (isOurs(existing.command)) {
    settings.statusLine = { type: "command", command: statusCommand(bin) };
    statusLine = "updated";
  } else if (force) {
    settings.statusLine = { type: "command", command: statusCommand(bin) };
    statusLine = "replaced";
    warnings.push("replaced an existing statusLine because --force was given; the old one is in the backup");
  } else {
    statusLine = "kept";
    warnings.push(
      "you already have a statusLine configured, so it was left alone. " +
      "Cost and context come from it, so the HUD will stay empty until you either " +
      "re-run with --force or call `foreman status` from your own script."
    );
  }

  let backupPath = null;
  if (!dryRun) {
    backupPath = backup(file);
    writeJson(file, settings);
  }

  return { file, backup: backupPath, added, skipped, statusLine, warnings, dryRun };
}

/** Remove everything we added. Leaves other hooks untouched. */
export function uninstall({ dryRun = false } = {}) {
  const file = claudeSettings();
  const settings = readJson(file, null);
  if (!settings) return { file, removed: [], statusLine: "absent", backup: null };

  const removed = [];
  for (const evt of Object.keys(settings.hooks ?? {})) {
    const list = settings.hooks[evt];
    if (!Array.isArray(list)) continue;
    const kept = list
      .map((g) => ({ ...g, hooks: (g?.hooks ?? []).filter((h) => !isOurs(h?.command)) }))
      .filter((g) => (g.hooks ?? []).length > 0);
    if (kept.length !== list.length || JSON.stringify(kept) !== JSON.stringify(list)) removed.push(evt);
    if (kept.length) settings.hooks[evt] = kept;
    else delete settings.hooks[evt];
  }
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  let statusLine = "absent";
  if (settings.statusLine && isOurs(settings.statusLine.command)) {
    delete settings.statusLine;
    statusLine = "removed";
  } else if (settings.statusLine) {
    statusLine = "left alone (not ours)";
  }

  let backupPath = null;
  if (!dryRun) {
    backupPath = backup(file);
    writeJson(file, settings);
  }
  return { file, removed, statusLine, backup: backupPath, dryRun };
}

/** What is actually wired right now. Used by `foreman doctor`. */
export function status() {
  const file = claudeSettings();
  const settings = readJson(file, null);
  if (!settings) return { file, exists: false, hooks: [], statusLine: false };

  const hooks = HOOK_EVENTS.filter((evt) =>
    (settings.hooks?.[evt] ?? []).some((g) => (g?.hooks ?? []).some((h) => isOurs(h?.command))));

  return {
    file,
    exists: true,
    hooks,
    missing: HOOK_EVENTS.filter((e) => !hooks.includes(e)),
    statusLine: isOurs(settings.statusLine?.command),
    foreignStatusLine: Boolean(settings.statusLine) && !isOurs(settings.statusLine?.command),
  };
}
