# Foreman — Claude Code plugin

**See what your coding agent is doing and what it's costing.**

This plugin wires Foreman's eight lifecycle hooks into Claude Code **without touching your
`settings.json`**. That is the whole reason it exists: the CLI's `fmn init` has to back up,
merge into, and rewrite a file you own. A plugin carries its own hooks, so there is nothing
to merge and nothing to clobber.

```bash
npm i -g @whd4/foreman          # the engine
claude --plugin-dir ./plugin   # try it for one session
```

Then `/foreman` in any session, or `fmn sessions` in a terminal.

---

## What it does

Eight hooks — `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
`SubagentStop`, `Notification`, `PreCompact`, `Stop` — each forward their payload to
`fmn hook`, which maps the event to an animation state **and re-reads the session transcript
for exact token counts**.

Cost and context are not available to hooks. They are handed to the status line only, and the
status line does not fire reliably — measured on 2026-07-30, hooks fired 157 times while the
status line fired 10 times and then stopped for 76 minutes. So Foreman reads the numbers from
the transcript instead, where they were sitting on disk the whole time.

---

## Architecture — why the engine is not bundled

The plugin ships **no copy of Foreman**. `scripts/hook.mjs` resolves the CLI at runtime:
`$FOREMAN_BIN`, then `fmn` on PATH, then known global-npm locations.

Two components, upgraded independently, nothing to keep in sync. The cost is that the CLI is
a prerequisite; the benefit is that a plugin update never ships a stale engine.

### Two rules the bridge exists to enforce

1. **Never break the session.** A hook that throws, hangs, or exits non-zero is far worse than
   one that does nothing. Every failure path exits 0 in silence. If `fmn` is not installed,
   the hooks run and do nothing — the character simply never appears.
2. **Never hang.** These run on every tool call, so the child process is killed after 4
   seconds and stdin reading gives up after 1.5.

---

## Layout

```
plugin/
├── .claude-plugin/
│   └── plugin.json           manifest — points at hooks/hooks.json
├── hooks/
│   └── hooks.json            8 events → scripts/hook.mjs via ${CLAUDE_PLUGIN_ROOT}
├── scripts/
│   └── hook.mjs              the bridge. resolves fmn, forwards stdin, always exits 0
├── skills/
│   └── foreman/SKILL.md      the /foreman command
└── README.md
```

---

## Verify it

```bash
claude plugin validate ./plugin
```

Checks `plugin.json`, `hooks/hooks.json`, and skill frontmatter for schema errors.

To confirm the bridge works without launching Claude Code at all:

```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"Grep","session_id":"test"}' \
  | node ./plugin/scripts/hook.mjs && echo "exit 0 — good"
```

It exits 0 whether or not `fmn` is present. That is the point.

---

## Plugin vs `fmn init`

| | `fmn init` | this plugin |
|---|---|---|
| Touches your `settings.json` | yes — backs up, merges | **no** |
| Can clobber another status line | guarded by `--force` | not applicable |
| Uninstall | `fmn uninstall` (deletes the status line) | remove the plugin |
| Status line readout | yes | no — use `/foreman` or `fmn serve` |

Use the plugin if you want the character and the numbers without anything editing your config.
Use `fmn init` if you specifically want the one-line status readout in your prompt.

Running both is redundant — hooks would fire twice per event. Harmless, but pointless.

---

MIT. Engine: [`@whd4/foreman`](https://www.npmjs.com/package/@whd4/foreman)
