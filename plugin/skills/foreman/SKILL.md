---
name: foreman
description: Show what the coding agents on this machine are doing and what they are costing — context percentage, token totals across every concurrent session, and the current animation state. Use when the user asks about token usage, context pressure, agent spend, "how full is this window", "what is this costing", "how many sessions are running", or asks to see the Foreman character or dashboard.
---

# Foreman — agent cost and context

Report what the agents on this machine are consuming. Numbers come from the session
transcripts on disk, so they are exact rather than estimated.

## How to answer

Run the command that matches what was asked, then report the numbers plainly. Do not
paraphrase or round away precision the user might act on.

**"What is this session at?" / context pressure**

```bash
fmn sample
```

**"How many agents are running?" / total spend across sessions**

```bash
fmn sessions
```

This is the number nothing else on the machine reports. Several agents running at once
multiply spend, and each session only ever sees its own share.

**"Is it working?" / something looks wrong**

```bash
fmn doctor
```

Reports what is wired, what is not, and — importantly — whether the state is older than the
numbers, which is how a frozen readout hides while looking healthy.

**"Show me the dashboard" / "show me the meters"**

```bash
fmn serve
```

Serves a live dashboard on `http://127.0.0.1:7961` with six interchangeable skins, all
driven by the same real data. Tell the user the URL; do not try to screenshot it.

## Two things to state honestly, every time

**Tokens are measured; cost is estimated.** Token counts come from the transcript and are
exact. Cost only appears when a price has been set, is always labelled `ESTIMATE`, and
carries its source. If no price is set the dollar figure is blank — say so rather than
guessing a rate.

**The window size is an assertion, not a measurement.** The transcript records how much was
sent, never how much was allowed. A percentage is always against a window the user asserted
via `fmn set windowTokens`. If usage exceeds it, that is reported as a contradiction rather
than clamped to 100%.

## If the CLI is missing

`fmn` comes from the `@whd4/foreman` npm package, which this plugin does not bundle:

```bash
npm i -g @whd4/foreman
```

The plugin's hooks already run without it — they simply do nothing until the CLI exists.
Nothing breaks; the character just never appears.
