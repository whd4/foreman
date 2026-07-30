// SVG renderer.
//
// The terminal renderer packs two pixels into one cell because a cell is twice as tall
// as it is wide. SVG has no such constraint: a sprite pixel is a square unit and the
// whole thing scales to any size without resampling. Same art, drawn as geometry
// instead of glyphs.
//
// This file never touches the state machine. States draw into a Frame through the
// scene helper in engine.js, so anything that renders in the terminal renders here —
// a new state costs nothing on this side.
//
// Two things keep the output small, which matters because the live view mutates this
// DOM rather than repainting it:
//   1. Adjacent same-colour pixels merge into one rect, horizontally then vertically.
//   2. Rects group under one <g fill="…"> per colour, so a colour is written once.
// The 12x9 crab drops from 80-odd pixels to roughly 30 rects.

import { Frame } from "./render.js";
import { createEngine, STATES } from "./engine.js";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
           .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/**
 * Seeded PRNG. Particle spawn uses Math.random, which would make two renders of the
 * same state differ — fine on screen, bad for an asset committed to a repo. Rendering
 * deterministically means an unchanged character produces a byte-identical file.
 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function withSeed(seed, fn) {
  if (seed === null || seed === undefined) return fn();
  const real = Math.random;
  Math.random = mulberry32(seed);
  try { return fn(); } finally { Math.random = real; }
}

/**
 * Merge a pixel buffer into the fewest rectangles that reproduce it exactly.
 * Horizontal runs first, then a vertical pass that extends a run downward when the
 * row below holds an identical run at the same x. Returns [{x,y,w,h,color}].
 */
export function mergeRects(frame) {
  const { w, h, px } = frame;
  const rects = [];
  const open = new Map(); // "x:w:color" -> the rect still growing downward

  for (let y = 0; y < h; y++) {
    const seen = new Set();
    let x = 0;
    while (x < w) {
      const color = px[y * w + x];
      if (!color) { x++; continue; }
      let end = x + 1;
      while (end < w && px[y * w + end] === color) end++;

      const key = `${x}:${end - x}:${color}`;
      seen.add(key);
      const grow = open.get(key);
      if (grow && grow.y + grow.h === y) {
        grow.h++;
      } else {
        const rect = { x, y, w: end - x, h: 1, color };
        rects.push(rect);
        open.set(key, rect);
      }
      x = end;
    }
    // a run that did not repeat on this row can no longer grow
    for (const key of [...open.keys()]) if (!seen.has(key)) open.delete(key);
  }
  return rects;
}

/** Tight content bounds of a frame, or null when nothing is drawn. */
export function bounds(frame) {
  const { w, h, px } = frame;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!px[y * w + x]) continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < x0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Merged rects as SVG markup, grouped by colour. No wrapper element. */
export function rectsToMarkup(rects, { indent = "  " } = {}) {
  const byColor = new Map();
  for (const r of rects) {
    if (!byColor.has(r.color)) byColor.set(r.color, []);
    byColor.get(r.color).push(r);
  }
  const out = [];
  for (const [color, list] of byColor) {
    const body = list
      .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"/>`)
      .join("");
    out.push(`${indent}<g fill="${esc(color)}">${body}</g>`);
  }
  return out.join("\n");
}

/**
 * A frame as a standalone <svg> document.
 * `scale` is CSS pixels per sprite pixel; the viewBox stays in sprite units so the
 * consumer can override the size without re-rendering.
 */
export function frameToSvg(frame, {
  scale = 8,
  background = null,
  trim = false,
  pad = 0,
  title = null,
  id = null,
  className = null,
  standalone = false,
} = {}) {
  const box = (trim ? bounds(frame) : null) ?? { x: 0, y: 0, w: frame.w, h: frame.h };
  const vx = box.x - pad, vy = box.y - pad;
  const vw = box.w + pad * 2, vh = box.h + pad * 2;

  const attrs = [
    'xmlns="http://www.w3.org/2000/svg"',
    `viewBox="${vx} ${vy} ${vw} ${vh}"`,
    `width="${vw * scale}"`,
    `height="${vh * scale}"`,
    // sprite art must not be smoothed at any zoom — this is the whole point of pixels
    'shape-rendering="crispEdges"',
    id ? `id="${esc(id)}"` : null,
    className ? `class="${esc(className)}"` : null,
    title ? 'role="img"' : 'aria-hidden="true"',
  ].filter(Boolean);

  const parts = [];
  if (standalone) parts.push('<?xml version="1.0" encoding="UTF-8"?>');
  parts.push(`<svg ${attrs.join(" ")}>`);
  if (title) parts.push(`  <title>${esc(title)}</title>`);
  if (background) parts.push(`  <rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="${esc(background)}"/>`);
  parts.push(rectsToMarkup(mergeRects(frame)));
  parts.push("</svg>");
  return parts.join("\n");
}

/** Frame dimensions that give a pack room to hop and to hold a prop overhead. */
export function defaultSize(pack) {
  const [cw, ch] = pack.size;
  return { width: Math.max(28, cw * 2 + 6), height: Math.max(16, ch * 2) };
}

/**
 * Render one animation state to SVG.
 * `t` is milliseconds into the state — states are pure functions of it, so the same
 * `t` always yields the same drawing (given `seed`).
 */
export function renderSvg(pack, {
  state = "idle",
  t = 0,
  hud = {},
  width,
  height,
  seed = 1,
  autoFromHud = false,
  ...svgOpts
} = {}) {
  if (!STATES[state]) {
    throw new Error(`unknown state '${state}'. Known: ${Object.keys(STATES).join(", ")}`);
  }
  const size = defaultSize(pack);
  const engine = createEngine(pack, {
    width: width ?? size.width,
    height: height ?? size.height,
    hud,
  });
  engine.setState(state, 0);
  withSeed(seed, () => engine.render(t, { autoFromHud, color: false }));
  // context pressure can override the requested state — describe what was drawn
  const drawn = engine.state;
  return frameToSvg(engine.frame, {
    title: svgOpts.title ?? `${pack.name}: ${drawn} — ${STATES[drawn].why}`,
    ...svgOpts,
  });
}

/**
 * One pose on its own, trimmed to the art. Prefers the pack's `vector` block when it
 * has one for this pose, so a pack that ships real curves gets them here; otherwise
 * the pixel grid is emitted as merged rects, which upscale cleanly regardless.
 */
export function poseSvg(pack, poseName = "stand", { scale = 8, pad = 0, alt = false, ...opts } = {}) {
  const vec = pack.vector?.poses?.[poseName];
  if (vec) {
    const palette = alt && pack.alt ? { ...pack.palette, ...pack.alt } : pack.palette;
    const paint = (v) => (v && palette[v]) || v || "none";
    const body = vec
      .map((p) => {
        const bits = [`d="${esc(p.d)}"`, `fill="${esc(paint(p.fill))}"`];
        if (p.stroke) bits.push(`stroke="${esc(paint(p.stroke))}"`);
        if (p.strokeWidth) bits.push(`stroke-width="${p.strokeWidth}"`);
        if (p.opacity !== undefined) bits.push(`opacity="${p.opacity}"`);
        return `  <path ${bits.join(" ")}/>`;
      })
      .join("\n");
    const vb = pack.vector.viewBox ?? `0 0 ${pack.size[0]} ${pack.size[1]}`;
    const [, , vw, vh] = vb.split(/\s+/).map(Number);
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${esc(vb)}" width="${vw * scale}" height="${vh * scale}"`,
      `     ${opts.title ? 'role="img"' : 'aria-hidden="true"'}>`,
      opts.title ? `  <title>${esc(opts.title)}</title>` : null,
      body,
      "</svg>",
    ].filter(Boolean).join("\n");
  }

  const grid = pack.poses[poseName];
  if (!grid) throw new Error(`character '${pack.name}' has no pose '${poseName}'`);
  const palette = alt && pack.alt ? { ...pack.palette, ...pack.alt } : pack.palette;
  const f = new Frame(grid[0].length, grid.length);
  f.blit(grid, palette, 0, 0);
  return frameToSvg(f, { scale, pad, trim: true, ...opts });
}

/** One prop on its own, trimmed. Same fallback rules as poseSvg. */
export function propSvg(pack, propName, { scale = 8, ...opts } = {}) {
  const prop = pack.props[propName];
  if (!prop) throw new Error(`character '${pack.name}' has no prop '${propName}'`);
  const palette = { ...pack.palette, ...(prop.palette || {}) };
  const f = new Frame(prop.grid[0].length, prop.grid.length);
  f.blit(prop.grid, palette, 0, 0);
  return frameToSvg(f, { scale, trim: true, ...opts });
}

/**
 * Every state on one page, grouped the way `foreman states` groups them, with the
 * trigger and the reason under each. This is the visual regression check: if a state
 * renders empty or off-frame, it is obvious here and nowhere else.
 */
export function contactSheet(pack, { t = 900, scale = 4, hud = {}, dark = true } = {}) {
  const groups = {};
  for (const [name, st] of Object.entries(STATES)) (groups[st.group] ??= []).push([name, st]);

  const cards = Object.entries(groups).map(([group, list]) => {
    const items = list.map(([name, st]) => `
      <figure class="card">
        <div class="art">${renderSvg(pack, { state: name, t, hud, scale, title: null })}</div>
        <figcaption>
          <b>${esc(name)}</b>
          <span class="trigger">${esc(st.trigger)}</span>
          <span class="why">${esc(st.why)}</span>
        </figcaption>
      </figure>`).join("");
    return `<section><h2>${esc(group)}</h2><div class="grid">${items}</div></section>`;
  }).join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>foreman — ${esc(pack.name)} — every state</title>
<style>
  :root { color-scheme: ${dark ? "dark" : "light"}; --bg:${dark ? "#14110f" : "#faf7f4"}; --fg:${dark ? "#efe7dd" : "#241c16"}; --dim:${dark ? "#9c8f83" : "#6d6259"}; --line:${dark ? "#2c2521" : "#e2d9d0"}; --card:${dark ? "#1c1815" : "#fff"}; }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem 1.25rem 4rem; background:var(--bg); color:var(--fg);
         font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { max-width:1100px; margin:0 auto 2rem; }
  h1 { font-size:1.4rem; margin:0 0 .35rem; }
  header p { margin:0; color:var(--dim); }
  section { max-width:1100px; margin:0 auto 2.5rem; }
  h2 { font-size:.75rem; letter-spacing:.14em; text-transform:uppercase; color:var(--dim);
       margin:0 0 .85rem; padding-bottom:.5rem; border-bottom:1px solid var(--line); }
  .grid { display:grid; gap:1rem; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); }
  .card { margin:0; background:var(--card); border:1px solid var(--line); border-radius:10px; overflow:hidden; }
  .art { display:flex; align-items:flex-end; justify-content:center; padding:.6rem;
         background:${dark ? "#100e0c" : "#f1ece6"}; border-bottom:1px solid var(--line); }
  .art svg { max-width:100%; height:auto; image-rendering:pixelated; }
  figcaption { padding:.6rem .7rem .7rem; display:flex; flex-direction:column; gap:.2rem; }
  figcaption b { font-size:.95rem; }
  .trigger { font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--dim); }
  .why { font-size:.82rem; color:var(--dim); }
</style></head>
<body>
  <header>
    <h1>${esc(pack.name)} — ${Object.keys(STATES).length} states</h1>
    <p>Rendered at t=${t}ms. Every state drawn by the same engine that drives the terminal.</p>
  </header>
  ${cards}
</body></html>`;
}
