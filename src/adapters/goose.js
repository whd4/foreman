// goose adapter.
//
// Spec source: https://goose-docs.ai/blog/2026/05/14/goose-hooks/ (read 2026-07-30).
// goose adopted the Open Plugins hooks specification on 2026-05-14. Verified from that
// page: plugins live at `~/.agents/plugins/<name>/`, each carrying `hooks/hooks.json`;
// hook payloads arrive as JSON on stdin as `{event, session_id, tool_name, tool_input,
// working_dir}`; `${PLUGIN_ROOT}` is set in the environment; `matcher` takes a regex and
// is optional.
//
// This adapter is structurally SAFER than the Claude Code one. There we edit a settings
// file the user owns, so we back up, merge, and refuse to clobber. Here goose gives us
// our own plugin directory, so installing is just writing our own file — nothing of the
// user's is touched, and uninstalling is removing what we created.
//
// KNOWN LIMIT, stated rather than hidden: goose's payload carries no transcript path, and
// the location of goose's own session logs is not verified here. So on goose the mascot
// animates correctly but cost and context stay empty. `status()` reports this so it
// cannot be mistaken for a broken install.

import fs from "node:fs";
import path from "node:path";
import { goosePlugins, backup, readJson, writeJson, ensureDir, isOurCommand, resolveBin } from "../paths.js";

export const id = "goose";
export const label = "goose";

/** Verified event names. Anything not listed here is not registered. */
export const HOOK_EVENTS = [
  "SessionStart", "SessionEnd", "Stop",
  "UserPromptSubmit",
  "PreToolUse", "PostToolUse", "PostToolUseFailure",
  "BeforeReadFile", "AfterFileEdit",
  "BeforeShellExecution", "AfterShellExecution",
];

/** Cost and context need a transcript; goose does not hand us one. */
export const PROVIDES_COST = false;

const PLUGIN_NAME = "foreman";

export const pluginDir = () => path.join(goosePlugins(), PLUGIN_NAME);
export const hooksFile = () => path.join(pluginDir(), "hooks", "hooks.json");

export { resolveBin };

export function detect() {
  // The plugin root is agent-neutral and goose creates it lazily, so its absence is not
  // proof goose is missing. Report what is actually observable and let the CLI say so.
  return fs.existsSync(goosePlugins());
}

function buildConfig(bin) {
  const cmd = `${bin} hook`;
  const hooks = {};
  for (const evt of HOOK_EVENTS) {
    // matcher is optional and omitting it fires for every tool, which is what we want:
    // the mascot reacts to all work, not a chosen subset.
    hooks[evt] = [{ hooks: [{ type: "command", command: cmd }] }];
  }
  return { hooks };
}

/**
 * Write the plugin. Returns { file, backup, events[], created, warnings[] }.
 * Writes nothing when `dryRun` is set.
 */
export function install({ dryRun = false, bin = resolveBin() } = {}) {
  const file = hooksFile();
  const warnings = [];
  const existed = fs.existsSync(file);

  if (!fs.existsSync(goosePlugins())) {
    warnings.push(`${goosePlugins()} does not exist yet — creating it. If goose is not installed, this plugin simply sits unused.`);
  }
  warnings.push("goose hook payloads carry no transcript path, so on goose the character animates but cost and context stay empty.");

  // If something else already wrote this file, keep a copy — it is ours by name, but
  // being wrong about that should not cost the user their config.
  let backupPath = null;
  if (!dryRun) {
    ensureDir(path.dirname(file));
    if (existed) backupPath = backup(file);
    writeJson(file, buildConfig(bin));
  }

  return { file, backup: backupPath, events: [...HOOK_EVENTS], created: !existed, warnings, dryRun };
}

/** Remove the plugin directory we created. Never touches anything else under the root. */
export function uninstall({ dryRun = false } = {}) {
  const file = hooksFile();
  const dir = pluginDir();
  if (!fs.existsSync(file)) return { file, removed: false, backup: null, dryRun };

  let backupPath = null;
  if (!dryRun) {
    backupPath = backup(file);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { file, removed: true, backup: backupPath, dryRun };
}

/** What is actually wired right now. Used by `foreman doctor`. */
export function status() {
  const file = hooksFile();
  const cfg = readJson(file, null);
  if (!cfg) {
    return { file, exists: false, events: [], missing: [...HOOK_EVENTS], providesCost: PROVIDES_COST };
  }
  const events = HOOK_EVENTS.filter((e) =>
    (cfg.hooks?.[e] ?? []).some((g) => (g?.hooks ?? []).some((h) => isOurCommand(h?.command))));

  return {
    file,
    exists: true,
    events,
    missing: HOOK_EVENTS.filter((e) => !events.includes(e)),
    providesCost: PROVIDES_COST,
  };
}
