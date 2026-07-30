# Changelog

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

- `foreman sample` — exact token counts, read from the transcript
- Sampling runs on **every hook**, so the numbers move as often as the character does
- Tail-read for the current prompt (O(1)) plus an incremental scan by byte offset for
  session totals (O(delta)). **1.05 ms warm** on a 1.79 MB transcript; 8.8 ms cold
- `foreman set windowTokens|price|character`

Two rules the new code will not break:

- **Tokens are measured, cost is estimated.** Token counts are exact. Cost needs a price
  table the transcript does not carry, so cost is reported *only* when a price is supplied,
  always labelled `ESTIMATE` with its source, and always noting which tokens it excludes. A
  guessed rate is worse than a blank.
- **The window size is an assertion, not a measurement.** A percentage is shown only against
  a window someone asserted, the assertion is labelled, and usage beyond it is flagged as a
  contradiction rather than clamped to 100%.

`foreman doctor` now compares the age of the state against the age of the numbers and says
outright when they have diverged — the failure that hid for 76 minutes.

### goose adapter

Second agent supported, against the Open Plugins hooks spec goose adopted 2026-05-14
(source: `goose-docs.ai/blog/2026/05/14/goose-hooks/`, read 2026-07-30).

- `foreman init goose` / `foreman uninstall goose`
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

- `foreman svg [state]`, `--all` (contact sheet), `--live`, `--pose`, `--prop`
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
