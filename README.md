# foreman

**See what your coding agent is doing — and what it's costing.**

Coding agents burn tokens and context invisibly. Foreman puts both on screen, carried by a
small character that reacts to what the agent is actually doing, so you catch a runaway
session out of the corner of your eye instead of in next month's bill.

Zero dependencies. Node 18+. MIT.

```
                ▄▀▀▀▀▀▀▄
               ▀▀██▀▀▀▀██▀      ctx ████████░░░░  62%   spend $6.40   haul
               ▀▀▀▀▀▀▀▀▀▀
                ▀▀ ▀▀ ▀▀
```

---

## Install

```bash
npm i -g @whd4/foreman
fmn init            # or: fmn init goose
fmn watch
```

Supported agents: **Claude Code** and **goose**.

For Claude Code, `init` wires hooks and a status line into your settings. It **backs the file
up first**, **merges** rather than replaces, and is safe to run twice. It will not overwrite a
status line you already have unless you pass `--force`. For goose it writes its own plugin at
`~/.agents/plugins/foreman/`, so nothing you own is touched at all.

Run `fmn init --dry-run` first if you want to see the change before it happens.

---

## Where the numbers come from

**From the agent's own transcript**, read on every hook. Not from the status line — that was
the original design and it was wrong.

Cost and context are handed to exactly one surface, the status line, and **it does not fire
reliably**. Measured in a live Claude Code session on 2026-07-30: hooks fired **157 times**
while the status line fired **10 times and then stopped for 76 minutes**, across two user
turns. The readout sat frozen while looking perfectly healthy — the worst way for an
instrument to fail.

What it did report was also wrong. It declared a `context_window_size` of **200,000** for a
model documented at **1M**, so a **305,569-token** prompt showed as **55%** of a window it had
supposedly already outgrown. Against 200k that computes to **152.8%** — impossible, which is
the proof the setting was wrong. The character would have told you to start a fresh window
while you were **30.6%** full.

Hooks, meanwhile, fire on every tool call and every payload carries `transcript_path`. The
transcript is JSONL, and assistant records carry exact token counts. The numbers were already
on disk; they just weren't being read.

```bash
fmn sample          # what it can see right now
fmn sample --json   # the same, for scripts
```

Reading the tail is O(1) in session length and totals accumulate incrementally by byte offset,
so this costs **~1 ms** on a 1.8 MB transcript — cheap enough to run on every tool call.

### Two things it will not do

**Tokens are measured; cost is estimated.** Token counts come from the transcript and are
exact. Cost needs a price table the transcript does not carry, so cost is reported *only* when
you supply a price — always labelled `ESTIMATE`, always with its source, always stating which
tokens it excludes. With no price set it shows a blank, because a guessed rate is worse than
nothing.

```bash
fmn set price opus-5-fast     # only rates verified against a dated source ship
```

**The window size is an assertion, not a measurement.** The transcript says how much was sent,
never how much was allowed. So a percentage appears only against a window you assert, the
assertion is labelled, and usage beyond it is flagged as a contradiction rather than quietly
clamped to 100%.

```bash
fmn set windowTokens 1000000
```

`fmn doctor` compares how old the state is against how old the numbers are and says
outright when they've diverged — the failure that hid for 76 minutes.

> **goose caveat:** goose's hook payloads carry no transcript path, so on goose the character
> animates correctly but cost and context stay empty. `fmn doctor` says so rather than
> letting it look broken.

---

## Several agents at once

You are probably running more than one. Every reading is keyed by session id, so concurrent
agents stop overwriting each other — and the totals get added up:

```bash
fmn sessions
```

```
  ● 3d273174   3s   26%   257,280 tok  dig
  ○ a42b2fcb   4s   40%   398,309 tok  hammer
  ○ f8faab57  46s   20%   202,099 tok  dig
  ○ b666aad2   2m   26%   254,674 tok  wake

  all sessions combined (4 active in the last 5 min, 4 total)
    output 824,100   input 1,791
    cache read 180,885,968   cache write 4,869,735
    812 assistant messages
```

That is real output from one developer's machine. Every session individually looked healthy at
20–40% of its window. **None of them knew about the other three.** Four agents is four times
the spend, and each one only ever shows you a quarter of it.

Earlier versions wrote every session into one pair of files, so the readout showed whichever
agent happened to fire last — a number that looked authoritative and meant nothing. Session ids
arrive inside hook payloads, which is untrusted input becoming a path, so they are sanitised
before they touch the filesystem.

---

## Commands

| Command | What it does |
|---|---|
| `fmn init [agent]` | Wire up `claude-code` (default) or `goose`. `--dry-run`, `--force` |
| `fmn watch` | Live character in your terminal. `--once` for a single frame |
| `fmn sample` | Read cost + context from the transcript. `--json`, `--window`, `--price` |
| `fmn sessions` | Every agent running, and the combined total |
| `fmn set <k> <v>` | `windowTokens`, `price`, `character` |
| `fmn status` | Print the readout. Called by the status line |
| `fmn hook` | Map a hook payload to a state **and refresh the numbers**. Reads stdin |
| `fmn emit <state>` | Set the state by hand — for loops and verifiers |
| `fmn svg [state]` | Render to SVG. `--all`, `--live`, `--pose`, `--prop`, `--out` |
| `fmn list` | Installed characters |
| `fmn use <name>` | Switch character |
| `fmn validate <file>` | Check a character pack before shipping it |
| `fmn states` | Every state and what triggers it |
| `fmn doctor` | What's wired, what isn't, and what the runtime last saw |
| `fmn uninstall` | Remove everything it added |

---

## What triggers what

Thirteen states fire off real hooks with no extra work:

| Hook | Condition | State |
|---|---|---|
| `SessionStart` | — | `wake` |
| `UserPromptSubmit` | — | `think` |
| `PreToolUse` | `Read` | `read` |
| `PreToolUse` | `Grep` · `Glob` · `WebSearch` | `dig` |
| `PreToolUse` | `Write` · `Edit` | `type` |
| `PreToolUse` | `Bash` | `hammer` |
| `PreToolUse` | `Agent` · `Task` | `summon` |
| `PostToolUse` | error or stderr present | `stumble` |
| `Notification` | — | `ping` |
| `PreCompact` | — | `stopSign` |
| `Stop` · `SubagentStop` | — | `flag` |

**Context pressure outranks all of them.** Past 55% the character starts hauling crates and
slows down; past 85% it drops everything and holds up the stop sign, because a fresh window
now costs less than continuing. That check runs on every frame, so it can't be masked by
whatever event fired last.

Things no hook knows about — a loop pass finishing, an adversarial verifier's verdict — are
one line from wherever you know it:

```bash
fmn emit flip
fmn emit highFive     # verifier confirmed
fmn emit refute       # verifier refuted
fmn emit trophy       # a verifiable goal met its criteria
```

---

## Characters

A character is a **grid of text and a palette**. No art tools, diffable in git, editable by
anyone.

```json
{
  "name": "crab",
  "license": "MIT",
  "palette": { "o": "#E8825A", "d": "#B85F3E", "h": "#F2A183", "k": "#2A1C14" },
  "hand": [6, 8],
  "poses": {
    "stand": [
      "...hhhooo...",
      "..oooooooo..",
      ".oooooooooo.",
      ".ookooookoo.",
      ".oooooooooo.",
      ".oooooooooo.",
      "..dddddddd..",
      "..oo.oo.oo..",
      "..o..o...o.."
    ]
  },
  "props": {
    "flag": { "grid": ["pwkwkw.", "pkwkwk."], "palette": { "p": "#3A322A", "w": "#F4EDE2" } }
  }
}
```

`.` is transparent. Every other character maps to a palette entry.

**The contract.** Required poses: `stand`, `stepA`, `stepB`, `crouch`, `slump`. Required
props: `flag`, `stop`, `crate`, `coin`. Optional but used when present: `hold` (arm raised),
`blink`, `alt` (a second palette for the verifier character), and props `bill`, `page`,
`shovel`, `hammer`, `trophy`, `star`, `spark`, `dust`, `q`, `bang`, `z`.

`hand: [x, y]` is where props are held — x offset from centre, height above the feet.
**Prop anchoring belongs to the pack, not the engine**, so a new character can't inherit a
misplaced prop.

Drop a pack in `~/.foreman/characters/`, run `fmn validate` on it, then `fmn use`.
The validator is strict about ragged grids and missing palette entries, because those render
as garbage that looks like an engine bug and waste an author's afternoon.

The engine owns the states; a pack owns the art. **Add a character without touching engine
code; add a state without touching any character.**

**Optional vector art.** Pixel packs already scale cleanly — merged rects are geometry, not
a bitmap — so you only need this if you want real curves at large sizes:

```json
"vector": {
  "viewBox": "0 0 12 9",
  "poses": { "stand": [{ "d": "M1 0 h10 v9 h-10 Z", "fill": "o" }] }
}
```

`fill` and `stroke` take a palette key or a `#rrggbb` literal. Coverage can be partial —
any pose without a vector entry falls back to its grid, and the validator warns rather
than failing.

---

## How it renders

Terminal cells are twice as tall as they are wide, so one sprite pixel per cell looks
stretched. Foreman packs **two vertical pixels into each cell** with a half-block glyph —
foreground paints the top half, background the bottom. Square pixels, double the vertical
resolution, no image protocol required.

It draws in place by rewinding the cursor, not by taking over the screen. Scrollback
survives and Ctrl-C leaves your terminal usable.

Honours `NO_COLOR` and `FORCE_COLOR`.

### Outside the terminal

The same engine renders to SVG, so a state looks the same in a README, a docs page, or a
desktop window as it does in your shell.

```bash
fmn svg hammer --out hammer.svg     # one state
fmn svg --all --out states.html     # every state on one page
fmn svg --live --out live.html      # the event-driven view
```

Pixels become **merged rectangles**, not a bitmap: adjacent same-colour pixels collapse
into one rect and rects group by colour. The art stays sharp at any size, and the crab
goes from 80-odd pixels to about 30 rects. Rendering is seeded, so an unchanged character
produces a byte-identical file — safe to commit.

`--live` is the one to embed in a desktop shell. It emits the SVG **once** and then only
writes attributes:

```js
foreman.setState("hammer");                      // pose + prop swap
foreman.setHud({ ctxPct: 62, costUsd: 4.10 });   // meter, spend, size
```

Motion is declared in CSS keyframes the browser owns. **No `requestAnimationFrame`, no
`setInterval`, no timer of any kind ships in that page** — measured at 0 DOM writes while
idle and 83 for a six-turn session, versus thousands of frames for a canvas loop. There
is a test asserting the loop never comes back. It also honours `prefers-reduced-motion`.

Live numbers outrank the last event in both renderers, through one shared function, so
the terminal and the window can't disagree: at **55%** he starts hauling, at **85%** he
holds up the stop sign. Those two figures are conventions chosen so the warning still
leaves you room to act — **not** measured degradation points. No such measurement exists.

---

## Privacy

Foreman reads only what your agent already emits: event names, tool names, and the
status-line numbers. **No code, prompts, file contents, or file paths beyond the current
directory name leave your machine.** There is no network call anywhere in this package.

State lives in two small files under `~/.foreman/`:

- `state.json` — what the agent is doing (written by hooks)
- `hud.json` — cost and context (written by the status line)

Split on purpose: they come from different sources at different rates, and a hook firing
twenty times a turn must not clobber cost data only the status line knows.

---

## Development

```bash
node --test "test/**/*.test.js"
```

37 tests, no test framework. They run against a throwaway `FOREMAN_HOME` and a fixture
settings file, so they never touch your real config.

Two overrides exist for testing and unusual setups:

- `FOREMAN_HOME` — where config and state live (default `~/.foreman`)
- `FOREMAN_CLAUDE_SETTINGS` — path to the agent's settings file

---

## Status

**v0.1.0. Early.** Claude Code is the only adapter so far. The package name is not yet
published — verify availability before relying on it.
