// Where everything lives. Kept in one place because path resolution is the
// thing most likely to differ per machine, and the thing most annoying to debug.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The command this installs onto a user's PATH.
 *
 * NOT "foreman". `foreman(1)` is Heroku's Procfile runner, a long-established Ruby tool
 * that already owns that name on a great many developer machines. The precedent is
 * unambiguous: the npm package literally described as "Node Implementation of Foreman"
 * ships its binary as `nf` rather than take it. Installing over someone's existing
 * `foreman` would be the rudest possible first impression, so the package keeps the name
 * and the command gets its own.
 */
export const BIN_NAME = "fmn";

/**
 * Command fragments that identify a hook as ours. "foreman" stays in the list so an
 * install from before the rename is still recognised — and therefore still removable by
 * `uninstall` — rather than being silently orphaned in someone's settings file.
 */
export const OUR_MARKS = [BIN_NAME, "foreman"];

/** True when a settings command belongs to us. */
export const isOurCommand = (cmd) =>
  typeof cmd === "string" && OUR_MARKS.some((m) => cmd.includes(m));

/** The command name to write into settings. Overridable for tests and odd installs. */
export const resolveBin = () => process.env.FOREMAN_BIN || BIN_NAME;

/** The installed package root (one level up from src/). */
export const pkgRoot = path.resolve(here, "..");

/** Characters bundled with the package. */
export const bundledCharacters = path.join(pkgRoot, "characters");

/** Per-user config + runtime state. Overridable for tests. */
export function configDir() {
  if (process.env.FOREMAN_HOME) return path.resolve(process.env.FOREMAN_HOME);
  return path.join(os.homedir(), ".foreman");
}

export const configFile  = () => path.join(configDir(), "config.json");
export const stateFile   = () => path.join(configDir(), "state.json");
export const hudFile     = () => path.join(configDir(), "hud.json");
export const userChars   = () => path.join(configDir(), "characters");

/**
 * Per-session storage.
 *
 * Agents run concurrently — three live Claude Code sessions were observed on one machine
 * on 2026-07-30, all firing hooks into the same two files. Whoever wrote last won, so the
 * readout jumped between unrelated sessions and the numbers meant nothing. State is keyed
 * by session from here on; the flat files above are kept as a "most recent activity" view
 * so older readers and `foreman watch` with no arguments still work.
 */
export const sessionsDir = () => path.join(configDir(), "sessions");
export const currentFile = () => path.join(configDir(), "current.json");

/**
 * Session ids arrive inside a hook payload, which is untrusted input that becomes a path.
 * Anything outside this set is stripped so a crafted id cannot escape the sessions folder.
 */
export function safeSessionId(id) {
  const s = String(id ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 128);
  // Stripping separators is not enough on its own: an id of exactly ".." survives the
  // filter and resolves to the PARENT directory, which would put a session's state file
  // on top of the top-level config. Anything that is only dots is not a name.
  if (!s || /^\.+$/.test(s)) return "unknown";
  return s.replace(/^\.+/, "") || "unknown";
}

export const sessionDir      = (id) => path.join(sessionsDir(), safeSessionId(id));
export const sessionStateFile = (id) => path.join(sessionDir(id), "state.json");
export const sessionHudFile   = (id) => path.join(sessionDir(id), "hud.json");

/**
 * Claude Code's settings file. Same location on every platform — Claude Code
 * uses ~/.claude regardless of OS rather than the platform config dir.
 */
export function claudeSettings() {
  if (process.env.FOREMAN_CLAUDE_SETTINGS) return path.resolve(process.env.FOREMAN_CLAUDE_SETTINGS);
  return path.join(os.homedir(), ".claude", "settings.json");
}

/**
 * goose's plugin root. Per the Open Plugins hooks spec that goose adopted
 * (goose-docs.ai/blog/2026/05/14/goose-hooks/, read 2026-07-30): user-scope plugins live
 * in `~/.agents/plugins/<name>/`, each with a `hooks/hooks.json`.
 *
 * Note this is NOT under `~/.config/goose` — the plugin spec is deliberately
 * agent-neutral, which is why the same directory can serve other adopters later.
 */
export function goosePlugins() {
  if (process.env.FOREMAN_GOOSE_PLUGINS) return path.resolve(process.env.FOREMAN_GOOSE_PLUGINS);
  return path.join(os.homedir(), ".agents", "plugins");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Read JSON, returning `fallback` on missing file or malformed content. */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Write JSON atomically-ish: temp file then rename, so a reader never sees a half file. */
export function writeJson(file, obj, { pretty = true } = {}) {
  ensureDir(path.dirname(file));
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, pretty ? 2 : 0));
  fs.renameSync(tmp, file);
  return file;
}

/** Timestamped backup beside the original. Returns the backup path, or null if nothing to back up. */
export function backup(file) {
  if (!fs.existsSync(file)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "").replace("T", "-").slice(0, 15);
  const dest = `${file}.backup-${stamp}`;
  fs.copyFileSync(file, dest);
  return dest;
}
