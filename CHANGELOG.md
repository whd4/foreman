# Changelog

## 0.6.1 — 2026-09-11

0.6.0 was tagged on 2026-08-09 but its publish run failed, so nothing after 0.5.0 ever
reached npm. This is the first release on npm since 0.5.0 and carries everything in the
0.6.0 section below as well.

### `/api/state` answers in milliseconds with thousands of sessions on disk

Every poll re-read every session's two files. With 2,009 session directories on disk
(2026-09-11) that took 5 s per poll on Windows, the page polls every 2 s, and the port
answered nothing for hours while the widgets showed stale numbers.

- **A session cache keyed by mtime and size** in `state.js`. An unchanged session costs two
  stats and no parse; a changed one costs a read.
- **The server walks only the hot set.** `listSessions({ full: false })` touches sessions that
  are live, current, or new, plus a rotating slice of 64 cold ones per call, so a session
  that wakes after an hour is caught on its next write or within about a minute.
- **The feed carries the newest 40 sessions plus every live one** instead of all of them
  (850 KB per poll before). `aggregate` still sums every session on disk.
- The snapshot TTL drops from 5 s to 1 s, and the one slow walk left is paid before the port
  opens. `fmn sessions` sums the walk it already did instead of walking twice.
- New: `resetSessionCache()` and `FRESH_MS` exported from the package root.

## 0.6.0 — 2026-08-09

Cost figures move for everyone in this release, in both directions. If you have been quoting
a number from 0.5.0, requote it.

### Cache reads and writes are priced — the order-of-magnitude bug

The cost model billed input and output only: cache writes were folded in at the *input* rate,
and cache reads were dropped entirely. On a cached agent workload that is not a rounding
error — one measured session carried **35.6M cache-read tokens against 1.4k input**.

- **Five rates, not two.** Cache writes bill above input, never at it.
- The 5-minute vs 1-hour cache TTL that Claude Code writes is genuinely unknown, so it is
  **reported as a range instead of resolved by a guess** — `usd` is the low bound, `usdHigh`
  the other end, and the CLI prints both whenever the choice moves the number.
- Rates resourced to `platform.claude.com/docs/en/about-claude/pricing`, read 2026-08-08,
  replacing the undated `anthropic-latest.md` reference.

### Claude Code plugin

Foreman now installs as a plugin, so **nothing edits your `settings.json`**. `fmn init` has to
back up, merge into, and rewrite a file you own, guarded by `--force` so it cannot clobber an
existing status line. A plugin carries its own hooks — nothing to merge, nothing to clobber,
and uninstalling is removing the plugin.

```bash
claude --plugin-dir ./plugin
```

- Eight lifecycle events forward to `fmn hook`. The engine is **not bundled**: the bridge
  resolves the CLI at runtime, so plugin and package upgrade independently.
- The bridge never breaks a session — every failure path exits 0, so a missing CLI just means
  the character never appears — and never hangs, with a 4-second kill on the child.
- Excluded from the npm tarball; installing the package does not carry it.

### The dashboard was rendering at 8% resolution

Reported as *"the line graph is so small, and numbers I can't see."* It was not small, it was
blurry, and the cause was a lost race rather than a layout choice. `fit()` sizes the canvas
backing store from its laid-out box and bails early when that box has no width — and it ran
once, inline, before layout exists on first load. Measured live: a **300×150 backing store
painted into 1074×300**, a 3.58× upscale of 8% of the pixels.

### Tests for the accounting nobody was checking

`subagentDir` and `scanSubagents` shipped exported and called on every hook with **zero
coverage**. Nineteen tests now pin them, including the three resume cases that matter: a file
that grew mid-stream, one that shrank, and one replaced at identical length with a newer
mtime — that last is invisible to an offset-only check and would report a stale total
forever. Suite: 122 → 141.

### `opus-5-standard` price preset

The table had only `opus-5-fast`, whose own note said standard-tier pricing was *not* that
number and was not verified. So anyone not running fast mode had two options: no cost at all,
or a figure overstated 2x. Standard is now the first preset listed, because it is what an
ordinary session actually bills at.

- **$5 / input MTok, $25 / output MTok**, sourced to the Anthropic models overview page and
  dated, per the rule every entry in this table follows. Confirmed against a second
  independent source before shipping — a wrong rate here is a confident wrong number, which
  is worse than the blank it replaces.
- Both notes now point at each other, so neither preset can be mistaken for the other.
- A test asserts the two rates stay distinct and that standard is the cheaper one; the
  generic preset test already required a dated source.

### Usage accounting was wrong in two directions at once

Cost figures move for everyone. See the commit for the measurements.

- **Streamed records were double-counted.** Claude writes several JSONL records per assistant
  message, each with a *cumulative* usage snapshot; summing them all overcounted output
  tokens 2.65x on a measured live transcript. Only the last snapshot per message id counts now.
- **Subagent spend was invisible.** Subagent transcripts live in a sibling tree, not a sibling
  file. On a measured session that was 49% of all activity. `totals` now means the whole
  session — parent plus subagents — because that is what "what did this cost" means.
- Context is deliberately *not* combined: a subagent's tokens never sat in this agent's window.
  Cost aggregates; context does not.

### `fmn serve`

A local dashboard on 127.0.0.1:7961. Six skins over one data feed — no sliders, no demo mode;
if a meter moves, a session moved.

## 0.5.0 — 2026-07-30

### The command is now `fmn`, not `foreman`

**Breaking.** The package is still `@whd4/foreman`; only the command it puts on your PATH
has changed.

`foreman(1)` is Heroku's Procfile runner — a long-established Ruby tool already installed on
a great many developer machines. Declaring `bin: {"foreman": …}` meant a global install would
drop `foreman`, `foreman.cmd` and `foreman.ps1` onto the user's PATH and shadow it. Installing
over somebody's existing tooling is the worst possible first impression, and it would have
been discovered by strangers rather than by us.

The precedent is unambiguous: the npm package described as *"Node Implementation of Foreman"*
ships its binary as **`nf`** rather than take the name. `fmn` is the same move. Verified before
choosing it — no npm package named `fmn`, and nothing by that name on PATH. (`fman` was
rejected: a real package already ships that binary.)

- `BIN_NAME`, `OUR_MARKS` and `isOurCommand` now live in one place in `paths.js`, so the name
  cannot drift between the two adapters again.
- **A pre-rename install is still recognised.** `isOurCommand` matches `foreman` as well as
  `fmn`, so hooks written by an earlier version are still detected by `doctor` and still
  removable by `uninstall`, rather than being silently orphaned in someone's settings file.
- Every command example in the CLI help, README and changelog was rewritten against an
  explicit subcommand list — deliberately not a blind word swap, so the package name, the
  goose plugin directory `~/.agents/plugins/foreman/`, and the historical `foreman-agent`
  references all survive untouched.

## 0.4.0 — 2026-07-30

### Readings are per session, and they add up

Found while verifying 0.3.0: **four Claude Code sessions were running concurrently on one
machine**, all firing hooks into the same `state.json` and `hud.json`. Last writer won, so the
readout showed a random session's numbers while looking completely authoritative.

State and HUD are now keyed by session id, which both agents send in every hook payload. The
flat files remain as a "most recent activity" view so `fmn watch` with no arguments still
works.

```
fmn sessions
```

```
  ● 3d273174   3s   26%   257,280 tok  dig
  ○ a42b2fcb   4s   40%   398,309 tok  hammer
  ○ f8faab57  46s   20%   202,099 tok  dig
  ○ b666aad2   2m   26%   254,674 tok  wake

  all sessions combined (4 active in the last 5 min, 4 total)
    output 824,100   cache read 180,885,968   812 assistant messages
```

Every session individually read as healthy. None knew about the other three. **This is the
aggregate view the whole thesis rests on** — N agents is N times the spend, and every tool in
this space shows you one Nth of it.

- `fmn sessions` — per-agent breakdown plus the combined total
- `listSessions()` / `aggregate()` exported for host applications
- Session ids come from an untrusted payload and become a path, so they are sanitised. An id
  of exactly `..` survives separator-stripping and resolves to the parent directory, which
  would have dropped a session file on top of the top-level config; ids that are only dots are
  now rejected. Covered by tests.

## 0.3.0 — 2026-07-30

### Cost and context now come from the transcript, not the status line

The status line was the only surface carrying cost and context, and **it does not fire
reliably**. Measured in a live Claude Code session: hooks fired **157 times** while the
status line fired **10 times and then stopped for 76 minutes**, across two user turns. The
readout sat frozen while looking perfectly healthy.

Worse, what it did report was wrong. It declared a `context_window_size` of **200,000** for
a model documented at **1M**, so a **305,569-token** prompt displayed as **55%** of a window
it had supposedly already outgrown. Computed honestly against 200k that is **152.8%** — an
impossible number, which is the proof the setting was wrong. The character would have thrown
up the stop sign telling you to start a fresh window while you were **30.6%** full.

So readings now come from the agent's own transcript, which hooks point at directly:

- `fmn sample` — exact token counts, read from the transcript
- Sampling runs on **every hook**, so the numbers move as often as the character does
- Tail-read for the current prompt (O(1)) plus an incremental scan by byte offset for
  session totals (O(delta)). **1.05 ms warm** on a 1.79 MB transcript; 8.8 ms cold
- `fmn set windowTokens|price|character`

Two rules the new code will not break:

- **Tokens are measured, cost is estimated.** Token counts are exact. Cost needs a price
  table the transcript does not carry, so cost is reported *only* when a price is supplied,
  always labelled `ESTIMATE` with its source, and always noting which tokens it excludes. A
  guessed rate is worse than a blank.
- **The window size is an assertion, not a measurement.** A percentage is shown only against
  a window someone asserted, the assertion is labelled, and usage beyond it is flagged as a
  contradiction rather than clamped to 100%.

`fmn doctor` now compares the age of the state against the age of the numbers and says
outright when they have diverged — the failure that hid for 76 minutes.

### goose adapter

Second agent supported, against the Open Plugins hooks spec goose adopted 2026-05-14
(source: `goose-docs.ai/blog/2026/05/14/goose-hooks/`, read 2026-07-30).

- `fmn init goose` / `fmn uninstall goose`
- Writes `~/.agents/plugins/foreman/hooks/hooks.json`, all 11 lifecycle events
- Structurally safer than the Claude Code adapter: goose gives us our own plugin directory,
  so nothing the user owns is edited
- Hook payloads are normalised (`hook_event_name` vs `event`) and tool names reduced to a
  verb, so a third agent costs one table row instead of a second event mapping
- goose's `developer__text_editor` reads *or* writes depending on its `command`, so the
  character no longer shows "writing" while the agent is only looking
- **Known limit, stated in `install()` and `doctor`:** goose sends no transcript path, so on
  goose the character animates but cost and context stay empty

### Renamed

`foreman-agent` was **already taken** on npm — v0.1.6, published 2026-05-31, described as
"Your local AI agents talk to each other. You should know what they're saying." That is an
adjacent tool in the same niche, so the name is not merely unavailable, it is confusing.
Published under a scope instead. **The unscoped name is still an open decision**, and the
scope must match the publishing npm account.

## 0.2.0 — 2026-07-30

### SVG renderer

States draw into a `Frame` through the scene helper and never touch pixels directly, so the
SVG path inherited all 22 states with no engine changes.

- `fmn svg [state]`, `--all` (contact sheet), `--live`, `--pose`, `--prop`
- Pixels merge into rectangles losslessly — the crab drops from ~80 pixels to ~30 rects —
  and group by colour, so the art scales without resampling
- Rendering is seeded, so an unchanged character produces a byte-identical file
- Optional `vector` block in the character contract, with per-pose fallback to pixel art
- **The live view ships no animation loop.** Motion is CSS keyframes the browser owns; JS
  only writes attributes on events. Measured at **0 DOM writes while idle** and 83 for a
  six-turn session. A test fails the build if `requestAnimationFrame`, `setInterval`, or
  `setTimeout` ever appears in the generated page. Honours `prefers-reduced-motion`
- Context thresholds live once, in `stateFromHud`, shared by both renderers. 55 and 85 are
  **conventions chosen for actionability, not measured degradation points**

## 0.1.0 — 2026-07-30

Terminal renderer, 22-state engine, character-pack contract, Claude Code adapter.
