// SVG renderer tests. Same sandbox discipline as the main suite: a throwaway
// FOREMAN_HOME so nothing here can touch a real config.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "foreman-svg-test-"));
process.env.FOREMAN_HOME = path.join(sandbox, "home");
process.env.FOREMAN_CLAUDE_SETTINGS = path.join(sandbox, "claude", "settings.json");

const { load, validate } = await import("../src/character.js");
const { Frame } = await import("../src/render.js");
const { STATES, stateNames, stateFromHud, CTX_HAUL, CTX_STOP } = await import("../src/engine.js");
const { mergeRects, bounds, frameToSvg, renderSvg, poseSvg, propSvg, contactSheet, defaultSize } =
  await import("../src/svg.js");
const { liveDocument, MOTION, resolveMotion } = await import("../src/svg-live.js");

const crab = load("crab");

/** Paint merged rects back into a grid so the merge can be checked losslessly. */
function expand(rects, w, h) {
  const px = new Array(w * h).fill(null);
  for (const r of rects)
    for (let y = r.y; y < r.y + r.h; y++)
      for (let x = r.x; x < r.x + r.w; x++) px[y * w + x] = r.color;
  return px;
}

function standFrame() {
  const grid = crab.poses.stand;
  const f = new Frame(grid[0].length, grid.length);
  f.blit(grid, crab.palette, 0, 0);
  return f;
}

// ── the merge must be lossless, or the SVG is not the same art ───────────────
test("mergeRects reproduces the pixel buffer exactly", () => {
  const f = standFrame();
  const back = expand(mergeRects(f), f.w, f.h);
  assert.deepEqual(back, f.px);
});

test("mergeRects reproduces every pose and prop exactly", () => {
  for (const [name, grid] of Object.entries(crab.poses)) {
    const f = new Frame(grid[0].length, grid.length);
    f.blit(grid, crab.palette, 0, 0);
    assert.deepEqual(expand(mergeRects(f), f.w, f.h), f.px, `pose ${name}`);
  }
  for (const [name, prop] of Object.entries(crab.props)) {
    const f = new Frame(prop.grid[0].length, prop.grid.length);
    f.blit(prop.grid, { ...crab.palette, ...(prop.palette || {}) }, 0, 0);
    assert.deepEqual(expand(mergeRects(f), f.w, f.h), f.px, `prop ${name}`);
  }
});

test("mergeRects actually merges — fewer rects than lit pixels", () => {
  const f = standFrame();
  const lit = f.px.filter(Boolean).length;
  const rects = mergeRects(f);
  assert.ok(rects.length < lit, `${rects.length} rects vs ${lit} pixels`);
  assert.ok(rects.length < lit * 0.6, `expected a real reduction, got ${rects.length}/${lit}`);
});

test("an empty frame yields no rects and no bounds", () => {
  const f = new Frame(8, 8);
  assert.deepEqual(mergeRects(f), []);
  assert.equal(bounds(f), null);
});

// ── document shape ──────────────────────────────────────────────────────────
test("frameToSvg emits a viewBox in sprite units and a scaled pixel size", () => {
  const f = standFrame();
  const svg = frameToSvg(f, { scale: 10 });
  assert.match(svg, /^<svg /);
  assert.match(svg, new RegExp(`viewBox="0 0 ${f.w} ${f.h}"`));
  assert.match(svg, new RegExp(`width="${f.w * 10}"`));
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, /<\/svg>$/);
});

test("frameToSvg trims to the art when asked", () => {
  const f = new Frame(20, 20);
  f.rect(6, 8, 3, 4, "#ffffff");
  const svg = frameToSvg(f, { trim: true, scale: 1 });
  assert.match(svg, /viewBox="6 8 3 4"/);
});

test("colours are written once per colour, not once per rect", () => {
  const svg = frameToSvg(standFrame(), { scale: 1 });
  const groups = svg.match(/<g fill=/g) ?? [];
  const colours = new Set(mergeRects(standFrame()).map((r) => r.color));
  assert.equal(groups.length, colours.size);
});

test("a pack name with markup in it cannot break out of the document", () => {
  const evil = { ...crab, name: '"><script>alert(1)</script>' };
  const svg = renderSvg(evil, { state: "idle" });
  assert.ok(!svg.includes("<script>"), "raw script tag leaked into the SVG");
  assert.match(svg, /&lt;script&gt;/);
});

// ── every state, not just the easy ones ─────────────────────────────────────
test("every state renders to an SVG with visible art", () => {
  for (const name of stateNames()) {
    const svg = renderSvg(crab, { state: name, t: 900 });
    assert.match(svg, /^<svg /, `${name}: not an svg`);
    assert.ok(/<rect /.test(svg), `${name}: rendered nothing`);
  }
});

test("the title describes what was drawn, not what was asked for", () => {
  // context pressure overrides the requested state; a title saying "idle" over a
  // drawn stop sign is a caption that lies
  const svg = renderSvg(crab, { state: "idle", hud: { ctxPct: 91 }, autoFromHud: true });
  assert.match(svg, /<title>crab: stopSign/);
});

test("renderSvg rejects an unknown state by name", () => {
  assert.throws(() => renderSvg(crab, { state: "nope" }), /unknown state 'nope'/);
});

test("renderSvg is deterministic for the same seed", () => {
  // particle spawn uses Math.random; without seeding, committed assets would churn
  const a = renderSvg(crab, { state: "hammer", t: 1200, hud: { burn: 0.9 }, seed: 7 });
  const b = renderSvg(crab, { state: "hammer", t: 1200, hud: { burn: 0.9 }, seed: 7 });
  assert.equal(a, b);
});

test("the whole state set fits inside the default frame", () => {
  // a state drawing outside the frame is silently clipped, which reads as a dead state
  const { width, height } = defaultSize(crab);
  for (const name of stateNames()) {
    const svg = renderSvg(crab, { state: name, t: 700, width, height });
    const rects = [...svg.matchAll(/<rect x="(-?\d+)" y="(-?\d+)" width="(\d+)" height="(\d+)"/g)];
    assert.ok(rects.length, `${name}: no rects`);
    for (const [, x, y, w, h] of rects) {
      assert.ok(Number(x) >= 0 && Number(x) + Number(w) <= width, `${name}: art escapes horizontally`);
      assert.ok(Number(y) >= 0 && Number(y) + Number(h) <= height, `${name}: art escapes vertically`);
    }
  }
});

test("poseSvg and propSvg trim to the art", () => {
  const p = poseSvg(crab, "stand", { scale: 4 });
  assert.match(p, /<svg /);
  assert.match(p, /<rect /);
  assert.match(propSvg(crab, "flag", { scale: 4 }), /<rect /);
  assert.throws(() => poseSvg(crab, "moonwalk"), /no pose 'moonwalk'/);
  assert.throws(() => propSvg(crab, "chainsaw"), /no prop 'chainsaw'/);
});

test("the alt palette changes the output", () => {
  assert.notEqual(poseSvg(crab, "stand"), poseSvg(crab, "stand", { alt: true }));
});

test("the contact sheet lists every state with its trigger", () => {
  const html = contactSheet(crab, { scale: 2 });
  for (const [name, st] of Object.entries(STATES)) {
    assert.ok(html.includes(`<b>${name}</b>`), `missing ${name}`);
    assert.ok(html.includes(st.why.replace(/'/g, "&#39;")), `missing reason for ${name}`);
  }
});

// ── vector block ────────────────────────────────────────────────────────────
test("a valid vector block passes validation and is used by poseSvg", () => {
  const pack = {
    ...crab,
    vector: { viewBox: "0 0 12 9", poses: { stand: [{ d: "M0 0 h12 v9 h-12 Z", fill: "o" }] } },
  };
  const v = validate(pack);
  assert.deepEqual(v.errors, []);
  const svg = poseSvg(pack, "stand");
  assert.match(svg, /<path /);
  assert.match(svg, /fill="#E8825A"/); // palette key resolved to its colour
});

test("a pose with no vector entry falls back to pixel art", () => {
  const pack = { ...crab, vector: { viewBox: "0 0 12 9", poses: { stand: [{ d: "M0 0 h1", fill: "o" }] } } };
  assert.match(poseSvg(pack, "slump"), /<rect /);
  assert.ok(!poseSvg(pack, "slump").includes("<path "));
});

test("validation catches a broken vector block", () => {
  const bad = validate({
    ...crab,
    vector: { viewBox: "0 0 12", poses: { stand: [{ fill: "nosuchkey" }] } },
  });
  assert.ok(!bad.ok);
  assert.ok(bad.errors.some((e) => /viewBox .* four numbers/.test(e)), bad.errors.join("; "));
  assert.ok(bad.errors.some((e) => /missing path data 'd'/.test(e)));
  assert.ok(bad.errors.some((e) => /neither a palette key nor a #rrggbb/.test(e)));
});

test("partial vector coverage warns rather than failing", () => {
  const v = validate({ ...crab, vector: { viewBox: "0 0 12 9", poses: { stand: [{ d: "M0 0 h1", fill: "o" }] } } });
  assert.ok(v.ok);
  assert.ok(v.warnings.some((w) => /fall back to pixel art/.test(w)));
});

// ── the live view ───────────────────────────────────────────────────────────
test("MOTION covers every state, and nothing that is not a state", () => {
  assert.deepEqual(Object.keys(MOTION).sort(), stateNames().sort());
});

test("resolveMotion drops poses and props the pack does not define", () => {
  const minimal = {
    ...crab,
    poses: { stand: crab.poses.stand, stepA: crab.poses.stepA, stepB: crab.poses.stepB,
             crouch: crab.poses.crouch, slump: crab.poses.slump },
    props: { flag: crab.props.flag, stop: crab.props.stop, crate: crab.props.crate, coin: crab.props.coin },
  };
  const m = resolveMotion(minimal);
  for (const [name, entry] of Object.entries(m)) {
    for (const p of entry.cycle) assert.ok(minimal.poses[p], `${name} wants missing pose ${p}`);
    if (entry.prop) assert.ok(minimal.props[entry.prop], `${name} wants missing prop ${entry.prop}`);
  }
  assert.equal(m.read.cycle[0], "stand", "should fall back when 'hold' is absent");
  assert.equal(m.doze.prop, null, "should drop the absent 'z' prop");
});

test("the live document ships no animation loop", () => {
  // The whole point of the SVG path is that the browser animates and JS only reacts.
  // If a loop ever creeps back in, this fails rather than quietly burning a core.
  const html = liveDocument(crab);
  for (const banned of ["requestAnimationFrame", "setInterval", "setTimeout", "new Date(", "Date.now("]) {
    assert.ok(!html.includes(banned), `live document contains ${banned}`);
  }
});

test("the live document is self-contained", () => {
  const html = liveDocument(crab);
  assert.ok(!/\bsrc\s*=/.test(html), "external resource referenced");
  assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(html), "external URL referenced");
  assert.match(html, /<style>/);
  assert.match(html, /<script>/);
});

test("the live document defines a group for everything the motion table can ask for", () => {
  const html = liveDocument(crab);
  const motion = resolveMotion(crab);
  for (const [name, m] of Object.entries(motion)) {
    for (const p of m.cycle) assert.ok(html.includes(`data-pose="${p}"`), `${name}: no group for pose ${p}`);
    if (m.prop) assert.ok(html.includes(`data-prop="${m.prop}"`), `${name}: no group for prop ${m.prop}`);
  }
});

test("walk-cycle frames are tagged explicitly, not by sibling position", () => {
  const html = liveDocument(crab);
  assert.match(html, /data-pose="stepA" data-cyc="a"/);
  assert.match(html, /data-pose="stepB" data-cyc="b"/);
});

test("the live viewBox leaves room for the tallest overhead prop", () => {
  const html = liveDocument(crab);
  const m = html.match(/viewBox="(-?\d+) (-?\d+) (\d+) (\d+)"/);
  assert.ok(m, "no viewBox");
  const [, , vy] = m.map(Number);
  const [, ch] = crab.size;
  const [, handY] = crab.hand;
  const tallest = Math.max(...Object.values(crab.props).map((p) => p.grid.length));
  assert.ok(vy <= ch - handY - tallest, `viewBox top ${vy} clips a ${tallest}-tall prop`);
});

test("the meter elements are block-level", () => {
  // caught in the browser: a span left inline reports the right colour and the right
  // width string while painting nothing at all, so the meter looked wired and was not
  const html = liveDocument(crab);
  assert.match(html, /#fm-track\s*\{[^}]*display:block/);
  assert.match(html, /#fm-fill\s*\{[^}]*display:block/);
});

test("the live document honours reduced motion", () => {
  assert.match(liveDocument(crab), /prefers-reduced-motion/);
});

// ── thresholds shared with the terminal ─────────────────────────────────────
test("stateFromHud drives the same overrides both renderers use", () => {
  assert.equal(stateFromHud("idle", {}), "idle", "no numbers means no override");
  assert.equal(stateFromHud("idle", { ctxPct: 10 }), "idle");
  assert.equal(stateFromHud("idle", { ctxPct: CTX_HAUL }), "haul");
  assert.equal(stateFromHud("hammer", { ctxPct: CTX_HAUL }), "hammer", "an active state outranks haul");
  assert.equal(stateFromHud("hammer", { ctxPct: CTX_STOP }), "stopSign", "a full window outranks everything");
  assert.equal(stateFromHud("idle", { ctxPct: 100 }), "stopSign");
});

test("the live document carries the same thresholds as the engine", () => {
  const html = liveDocument(crab);
  assert.match(html, new RegExp(`HAUL=${CTX_HAUL},STOP=${CTX_STOP}`));
});
