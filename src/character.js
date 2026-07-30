// Character packs. This is the contract that makes the engine character-agnostic:
// the engine owns the STATES, a pack owns the ART. Any pack satisfying the contract
// below works with every state, so a new character never needs engine changes.

import fs from "node:fs";
import path from "node:path";
import { bundledCharacters, userChars, readJson } from "./paths.js";

/** Poses every pack must define. States are written against these names only. */
export const REQUIRED_POSES = ["stand", "stepA", "stepB", "crouch", "slump"];

/** Props every pack must define. Anything beyond these is optional and state-specific. */
export const REQUIRED_PROPS = ["flag", "stop", "crate", "coin"];

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Validate a pack. Returns { ok, errors[], warnings[] }.
 * Deliberately strict about geometry — a ragged grid renders as garbage that looks
 * like an engine bug rather than a bad pack, which wastes an author's afternoon.
 */
export function validate(pack) {
  const errors = [];
  const warnings = [];

  if (!pack || typeof pack !== "object") return { ok: false, errors: ["pack is not an object"], warnings };
  if (!pack.name) errors.push("missing 'name'");
  if (!pack.palette || typeof pack.palette !== "object") errors.push("missing 'palette'");

  for (const [k, v] of Object.entries(pack.palette || {})) {
    if (k.length !== 1) errors.push(`palette key '${k}' must be a single character`);
    if (!HEX.test(v)) errors.push(`palette['${k}'] = '${v}' is not a #rrggbb hex colour`);
  }
  if (pack.palette && "." in pack.palette) errors.push("'.' is reserved for transparent and cannot be a palette key");

  const checkGrid = (label, grid, palette) => {
    if (!Array.isArray(grid) || grid.length === 0) { errors.push(`${label}: grid must be a non-empty array of strings`); return; }
    const w = grid[0].length;
    grid.forEach((row, i) => {
      if (typeof row !== "string") { errors.push(`${label}: row ${i} is not a string`); return; }
      if (row.length !== w) errors.push(`${label}: row ${i} is ${row.length} chars, expected ${w} — every row must be the same width`);
      for (const ch of row) {
        if (ch === "." || ch === " ") continue;
        if (!(ch in palette)) errors.push(`${label}: character '${ch}' has no palette entry`);
      }
    });
  };

  const poses = pack.poses || {};
  for (const p of REQUIRED_POSES) {
    if (!poses[p]) errors.push(`missing required pose '${p}'`);
  }
  for (const [name, grid] of Object.entries(poses)) checkGrid(`poses.${name}`, grid, pack.palette || {});

  // every pose must share one footprint, or the creature jumps between frames
  const dims = Object.entries(poses)
    .filter(([, g]) => Array.isArray(g) && g.length)
    .map(([n, g]) => [n, g[0].length, g.length]);
  if (dims.length) {
    const [, w0, h0] = dims[0];
    for (const [n, w, h] of dims) {
      if (w !== w0 || h !== h0) errors.push(`poses.${n} is ${w}x${h} but poses.${dims[0][0]} is ${w0}x${h0} — all poses must share one size`);
    }
  }

  const props = pack.props || {};
  for (const p of REQUIRED_PROPS) if (!props[p]) errors.push(`missing required prop '${p}'`);
  for (const [name, prop] of Object.entries(props)) {
    if (!prop || !Array.isArray(prop.grid)) { errors.push(`props.${name}: missing 'grid'`); continue; }
    checkGrid(`props.${name}`, prop.grid, { ...(pack.palette || {}), ...(prop.palette || {}) });
  }

  // Optional vector art. Pixel packs already scale — merged rects are geometry, not a
  // bitmap — so this block is only for packs that want real curves at large sizes.
  // Partial coverage is fine: any pose without a vector entry falls back to its grid.
  if (pack.vector !== undefined) {
    const v = pack.vector;
    if (!v || typeof v !== "object") {
      errors.push("'vector' must be an object");
    } else {
      if (v.viewBox !== undefined && typeof v.viewBox !== "string") {
        errors.push("vector.viewBox must be a string like '0 0 12 9'");
      }
      if (v.viewBox && v.viewBox.trim().split(/\s+/).length !== 4) {
        errors.push(`vector.viewBox '${v.viewBox}' must have four numbers`);
      }
      const checkPaths = (label, paths) => {
        if (!Array.isArray(paths)) { errors.push(`${label} must be an array of paths`); return; }
        paths.forEach((p, i) => {
          if (!p || typeof p !== "object") { errors.push(`${label}[${i}] is not an object`); return; }
          if (typeof p.d !== "string" || !p.d.trim()) errors.push(`${label}[${i}] missing path data 'd'`);
          for (const key of ["fill", "stroke"]) {
            const val = p[key];
            if (val === undefined) continue;
            if (typeof val !== "string") { errors.push(`${label}[${i}].${key} must be a string`); continue; }
            if (val !== "none" && !HEX.test(val) && !(val in (pack.palette || {})))
              errors.push(`${label}[${i}].${key} = '${val}' is neither a palette key nor a #rrggbb hex colour`);
          }
        });
      };
      for (const [name, paths] of Object.entries(v.poses || {})) checkPaths(`vector.poses.${name}`, paths);
      if (v.poses) {
        const missing = REQUIRED_POSES.filter((p) => !v.poses[p]);
        if (missing.length && missing.length < REQUIRED_POSES.length)
          warnings.push(`vector art covers only some poses — ${missing.join(", ")} will fall back to pixel art`);
      }
    }
  }

  if (!pack.license) warnings.push("no 'license' field — set one so redistribution is unambiguous");
  if (!pack.author)  warnings.push("no 'author' field");

  return { ok: errors.length === 0, errors, warnings };
}

/** All discoverable pack files, user packs shadowing bundled ones by name. */
export function discover() {
  const found = new Map();
  for (const dir of [bundledCharacters, userChars()]) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith(".json")) continue;
      found.set(path.basename(f, ".json"), path.join(dir, f));
    }
  }
  return found;
}

export function list() {
  return [...discover().entries()].map(([name, file]) => {
    const pack = readJson(file, null);
    return {
      name,
      file,
      ok: pack ? validate(pack).ok : false,
      author: pack?.author ?? null,
      license: pack?.license ?? null,
      poses: pack ? Object.keys(pack.poses || {}).length : 0,
      props: pack ? Object.keys(pack.props || {}).length : 0,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** Load a pack by name (or explicit path). Throws with the validation errors if invalid. */
export function load(nameOrPath) {
  let file = nameOrPath;
  if (!nameOrPath.endsWith(".json")) {
    const hit = discover().get(nameOrPath);
    if (!hit) throw new Error(`no character named '${nameOrPath}'. Run 'foreman list' to see what's installed.`);
    file = hit;
  }
  const pack = readJson(file, null);
  if (!pack) throw new Error(`could not read or parse ${file}`);
  const v = validate(pack);
  if (!v.ok) throw new Error(`character '${pack.name ?? file}' is invalid:\n  - ${v.errors.join("\n  - ")}`);
  pack._file = file;
  pack.size = [pack.poses.stand[0].length, pack.poses.stand.length];
  return pack;
}
