// Where everything lives. Kept in one place because path resolution is the
// thing most likely to differ per machine, and the thing most annoying to debug.

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

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
