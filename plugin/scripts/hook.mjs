#!/usr/bin/env node
// Foreman plugin hook bridge.
//
// Claude Code fires this on eight lifecycle events. It forwards the hook payload to the
// Foreman CLI, which maps the event to an animation state and re-reads the session
// transcript for exact token counts.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE:
//
//   1. NEVER break the user's session. A hook that throws, hangs, or exits non-zero is far
//      worse than a hook that does nothing. Every failure path here exits 0 in silence.
//   2. NEVER hang. Hooks run on every tool call, so a stuck child process would stall the
//      agent. The child is killed after a hard timeout.
//
// Foreman is resolved at runtime rather than bundled: the plugin carries no copy of the
// engine, so the two can be upgraded independently and there is nothing to keep in sync.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const TIMEOUT_MS = 4000;

/** Read stdin fully, but never wait forever for it. */
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    const done = (v) => resolve(v ?? data);
    const t = setTimeout(() => done(data), 1500);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { data += c; });
    process.stdin.on("end", () => { clearTimeout(t); done(data); });
    process.stdin.on("error", () => { clearTimeout(t); done(""); });
  });
}

/**
 * Find the Foreman CLI. `fmn` on PATH is the normal case; the explicit paths cover a
 * global npm install that hasn't been rehashed into the current shell's PATH yet.
 */
function candidates() {
  const home = os.homedir();
  const list = [];
  if (process.env.FOREMAN_BIN) list.push({ cmd: process.env.FOREMAN_BIN, args: [] });

  // Bare `fmn` resolves via PATH on POSIX. On Windows the global npm bin is `fmn.cmd`, and
  // spawn without a shell won't find it by bare name — so name the shim explicitly.
  if (process.platform === "win32") {
    const npmDir = path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm");
    list.push({ cmd: path.join(npmDir, "fmn.cmd"), args: [] });
  } else {
    list.push({ cmd: "fmn", args: [] });
  }

  const guesses = process.platform === "win32"
    ? [
        path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm", "fmn.cmd"),
        path.join(home, "AppData", "Roaming", "npm", "node_modules", "@whd4", "foreman", "bin", "foreman.js"),
      ]
    : [
        "/usr/local/bin/fmn",
        path.join(home, ".npm-global", "bin", "fmn"),
        path.join(home, ".nvm", "versions", "node", "current", "bin", "fmn"),
      ];

  for (const g of guesses) {
    if (!existsSync(g)) continue;
    list.push(g.endsWith(".js") ? { cmd: process.execPath, args: [g] } : { cmd: g, args: [] });
  }
  return list;
}

/**
 * Run one candidate. Resolves true on a clean exit, false on anything else.
 *
 * `shell: true` is deliberately NOT used. Node emits DEP0190 whenever args are passed with a
 * shell, and a hook that fires on every tool call would print that warning to stderr a
 * hundred-plus times a session. Windows `.cmd` shims are invoked through ComSpec directly,
 * which needs no shell and stays quiet.
 */
function run(c, payload) {
  return new Promise((resolve) => {
    let file = c.cmd;
    let args = [...c.args, "hook"];

    if (process.platform === "win32" && /\.(cmd|bat)$/i.test(c.cmd)) {
      file = process.env.ComSpec || "cmd.exe";
      args = ["/d", "/s", "/c", c.cmd, ...c.args, "hook"];
    }

    let child;
    try {
      child = spawn(file, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    } catch { return resolve(false); }

    const kill = setTimeout(() => { try { child.kill(); } catch {} resolve(false); }, TIMEOUT_MS);
    child.on("error", () => { clearTimeout(kill); resolve(false); });
    child.on("close", (code) => { clearTimeout(kill); resolve(code === 0); });

    try { child.stdin.end(payload); } catch { /* child already gone */ }
  });
}

const payload = await readStdin();
if (payload) {
  for (const c of candidates()) {
    if (await run(c, payload)) break;   // first one that works wins
  }
}
process.exit(0);   // always. see rule 1.
