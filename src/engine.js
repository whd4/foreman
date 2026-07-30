// The state machine and the animation states.
//
// Contract: states reference POSE and PROP NAMES only, never pixels. A character pack
// supplies the art. Add a character without touching this file; add a state without
// touching any character.

import { Frame } from "./render.js";

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sin = (t, hz) => Math.sin((t / 1000) * hz * Math.PI * 2);
const easeOut = (v) => 1 - Math.pow(1 - clamp01(v), 3);

/**
 * Every state gets this. `s` is the scene helper — the only way states touch pixels,
 * which keeps them portable across renderers.
 */
function scene(f, pack, hud) {
  const [cw, ch] = pack.size;
  const floor = f.h - 1;
  // The pack declares where its hand is: [x offset from centre, height above feet].
  // Prop anchoring is a pack property so a new character can't inherit a misplaced prop.
  const [handX, handY] = pack.hand ?? [Math.ceil(cw / 2), 8];

  return {
    f, pack, hud,
    W: f.w, H: f.h, floor, cw, ch,
    mid: Math.round(f.w / 2),

    /** Draw the creature standing with its feet on `feetY`, centred on `cx`. */
    body(cx, feetY, poseName = "stand", { flip = false, alt = false } = {}) {
      const pose = pack.poses[poseName] || pack.poses.stand;
      const pal = alt && pack.alt ? { ...pack.palette, ...pack.alt } : pack.palette;
      f.blit(pose, pal, cx - Math.floor(cw / 2), feetY - pose.length, { flip });
      return this;
    },

    /** Draw a prop in the creature's hand. Anchoring comes from the pack, not from here. */
    hold(cx, feetY, propName, { dy = 0, flip = false } = {}) {
      const p = pack.props[propName];
      if (!p) return this;
      const pal = { ...pack.palette, ...(p.palette || {}) };
      f.blit(p.grid, pal, cx - Math.floor(cw / 2) + handX, feetY - handY - p.grid.length + dy, { flip });
      return this;
    },

    /** Draw a prop at an absolute position. */
    at(propName, x, y, { flip = false } = {}) {
      const p = pack.props[propName];
      if (!p) return this;
      f.blit(p.grid, { ...pack.palette, ...(p.palette || {}) }, x, y, { flip });
      return this;
    },

    has(propName) { return Boolean(pack.props[propName]); },

    /** Alternating walk cycle. */
    step(t, hz) { return Math.floor(t / (1000 / (hz * 2))) % 2 ? "stepA" : "stepB"; },

    /** Ping-pong across the available width. Returns {x, face}. */
    patrol(t, speed, pad = Math.ceil(cw / 2) + 1) {
      const span = Math.max(4, f.w - pad * 2);
      const period = ((span * 2) / Math.max(0.05, speed)) * 90;
      const u = (t % period) / period;
      const fwd = u < 0.5;
      return { x: Math.round(pad + span * (fwd ? u * 2 : (1 - u) * 2)), face: fwd ? 1 : -1 };
    },
  };
}

/** A prop-shaped particle, used for coins, bills and dust. */
function spawn(list, x, y, prop, { spread = 1.2, vy = -0.55, g = 0.035, life = 46 } = {}) {
  list.push({ x, y, prop, vx: (Math.random() - 0.5) * spread, vy, g, life, t: 0 });
}
function stepParticles(list, s) {
  for (const p of list) { p.t++; p.x += p.vx; p.y += p.vy; p.vy += p.g; }
  const keep = list.filter((p) => p.t < p.life && p.y < s.H + 4);
  list.length = 0; list.push(...keep);
  for (const p of list) s.at(p.prop, Math.round(p.x), Math.round(p.y));
}

export const STATES = {
  // ── ambient ────────────────────────────────────────────────────────────
  idle: { group: "ambient", dur: null, trigger: "default", why: "Nothing running.",
    draw(s, t) {
      const blink = s.pack.poses.blink && t % 3400 < 130;
      s.body(s.mid, s.floor + (sin(t, 0.35) > 0.6 ? -1 : 0), blink ? "blink" : "stand");
    } },

  patrol: { group: "ambient", dur: null, trigger: "idle > 8s", why: "Walking the bar.",
    draw(s, t) { const p = s.patrol(t, 1.1); s.body(p.x, s.floor, s.step(t, 3), { flip: p.face < 0 }); } },

  doze: { group: "ambient", dur: null, trigger: "idle > 3m", why: "Session gone quiet.",
    draw(s, t) {
      s.body(s.mid, s.floor, "crouch");
      if (s.has("z")) s.at("z", s.mid + 5, s.floor - 12 - Math.round(sin(t, 0.3)));
    } },

  wake: { group: "ambient", dur: 1400, trigger: "SessionStart", why: "Session opened.",
    draw(s, t) {
      const u = easeOut(t / 900);
      s.body(s.mid, s.floor + Math.round(14 * (1 - u)), u < 0.85 ? "crouch" : "stand");
    } },

  ping: { group: "ambient", dur: 1400, trigger: "Notification", why: "Claude needs you.",
    draw(s, t) {
      const hop = Math.round(Math.abs(sin(t, 2.2)) * 3);
      s.body(s.mid, s.floor - hop, "stand");
      if (s.has("bang")) s.hold(s.mid, s.floor - hop, "bang");
    } },

  // ── working ────────────────────────────────────────────────────────────
  think: { group: "working", dur: null, trigger: "UserPromptSubmit", why: "Reasoning.",
    draw(s, t) {
      s.body(s.mid, s.floor, "stand");
      if (s.has("q")) s.hold(s.mid, s.floor, "q", { dy: -Math.round(Math.abs(sin(t, 0.6))) });
    } },

  read: { group: "working", dur: null, trigger: "PreToolUse: Read", why: "Reading a file.",
    draw(s, t) {
      const bob = sin(t, 0.5) > 0 ? 0 : -1;
      s.body(s.mid, s.floor + bob, s.pack.poses.hold ? "hold" : "stand");
      s.hold(s.mid, s.floor + bob, s.has("page") ? "page" : "crate", { flip: t % 2200 < 180 });
    } },

  dig: { group: "working", dur: null, trigger: "PreToolUse: Grep / Glob", why: "Searching the codebase.",
    draw(s, t, p) {
      const down = (t % 620) / 620 > 0.5;
      s.body(s.mid, s.floor, down ? "crouch" : "stand");
      if (s.has("shovel")) s.hold(s.mid, s.floor, "shovel", { dy: down ? 5 : 0 });
      if (t % 620 < 20 && s.has("dust")) spawn(p, s.mid + 6, s.floor - 1, "dust", { vy: -0.7 });
    } },

  type: { group: "working", dur: null, trigger: "PreToolUse: Write / Edit", why: "Writing code.",
    draw(s, t, p) {
      s.body(s.mid, s.floor, t % 260 < 130 ? "crouch" : "stand");
      if (t % 260 < 16 && s.has("spark")) spawn(p, s.mid + 5, s.floor - 4, "spark", { life: 20, vy: -0.5 });
    } },

  hammer: { group: "working", dur: null, trigger: "PreToolUse: Bash", why: "Running a command.",
    draw(s, t, p) {
      const u = (t % 500) / 500, hit = u > 0.55 && u < 0.72;
      s.body(s.mid, s.floor, hit ? "crouch" : "stand");
      if (s.has("hammer")) s.hold(s.mid, s.floor, "hammer", { dy: hit ? 6 : 0 });
      if (u > 0.55 && u < 0.6 && s.has("spark")) spawn(p, s.mid + 7, s.floor - 3, "spark", { life: 16, spread: 2 });
    } },

  sprint: { group: "working", dur: null, trigger: "long tool chain", why: "Heavy tool traffic.",
    draw(s, t) { const p = s.patrol(t, 3.2); s.body(p.x, s.floor, s.step(t, 8), { flip: p.face < 0 }); } },

  haul: { group: "working", dur: null, trigger: "context filling", why: "Carrying the context load.",
    draw(s, t) {
      const load = clamp01(((s.hud?.ctxPct ?? 60) - 55) / 28);
      const p = s.patrol(t, Math.max(0.35, 1.4 - load));
      s.body(p.x, s.floor, s.step(t, Math.max(1.2, 3 - load * 1.8)), { flip: p.face < 0 });
      for (let i = 0; i < Math.max(1, Math.ceil(load * 3)); i++)
        s.at("crate", p.x - p.face * (s.cw - 1) - 3, s.floor - 4 - i * 5);
    } },

  juggle: { group: "working", dur: null, trigger: "parallel tool calls", why: "Several calls at once.",
    draw(s, t) {
      s.body(s.mid, s.floor, s.pack.poses.hold ? "hold" : "stand");
      for (let i = 0; i < 3; i++) {
        const u = (t / 780 + i / 3) % 1;
        s.at("coin", Math.round(s.mid - 4 + 8 * u), Math.round(s.floor - 12 - Math.sin(u * Math.PI) * 6));
      }
    } },

  // ── crew ───────────────────────────────────────────────────────────────
  summon: { group: "crew", dur: 2600, trigger: "PreToolUse: Agent", why: "Subagents dispatched.",
    draw(s, t) {
      s.body(s.mid, s.floor, s.pack.poses.hold ? "hold" : "stand");
      for (let i = 0; i < 3; i++) {
        if (t < 220 + i * 380) continue;
        s.body(s.mid - (s.cw - 2) * (i + 1), s.floor, "crouch", { alt: true });
      }
    } },

  // ── loop ───────────────────────────────────────────────────────────────
  flip: { group: "loop", dur: 1000, trigger: "loop pass complete", why: "One pass done.",
    draw(s, t) {
      const u = clamp01(t / 820);
      const hop = Math.round(Math.sin(u * Math.PI) * 8);
      s.body(s.mid, s.floor - hop, u > 0.15 && u < 0.85 ? "crouch" : "stand", { flip: u > 0.5 });
    } },

  // ── signal ─────────────────────────────────────────────────────────────
  stopSign: { group: "signal", dur: null, trigger: "PreCompact / ctx >= 85%", why: "Out of room — start a fresh window.",
    draw(s, t) {
      const sh = Math.round(sin(t, 2.4));
      s.body(s.mid + sh, s.floor, s.pack.poses.hold ? "hold" : "stand");
      s.hold(s.mid + sh, s.floor, "stop", { dy: -Math.round(Math.abs(sin(t, 0.8))) });
    } },

  stumble: { group: "signal", dur: 1500, trigger: "PostToolUse: error", why: "A tool call failed.",
    draw(s, t) {
      const u = clamp01(t / 500);
      s.body(s.mid + Math.round(u * 3), s.floor, u > 0.55 ? "slump" : "crouch");
      if (u >= 1 && s.has("star")) s.hold(s.mid + 3, s.floor, "star", { dy: -Math.round(sin(t, 1.4)) });
    } },

  facepalm: { group: "signal", dur: 1800, trigger: "tests failed", why: "The suite went red.",
    draw(s) { s.body(s.mid, s.floor, "slump"); } },

  // ── verdict ────────────────────────────────────────────────────────────
  flag: { group: "verdict", dur: 2600, trigger: "Stop — turn complete", why: "Run finished.",
    draw(s, t) {
      s.body(s.mid, s.floor, s.pack.poses.hold ? "hold" : "stand");
      s.hold(s.mid, s.floor, "flag", { dy: Math.floor(t / 150) % 2 ? 0 : -1 });
    } },

  highFive: { group: "verdict", dur: 3200, trigger: "verifier CONFIRMED", why: "Verification passed.",
    draw(s, t, p) {
      const u = easeOut(t / 1100);
      const gx = Math.round(s.W + 4 - (s.W + 4 - (s.mid + s.cw - 1)) * u);
      const hit = t > 1100;
      const b = hit ? Math.round(Math.abs(sin(t - 1100, 2))) : 0;
      s.body(s.mid - Math.floor(s.cw / 2), s.floor - b, s.pack.poses.hold ? "hold" : "stand");
      s.body(gx, s.floor - b, s.pack.poses.hold ? "hold" : "stand", { flip: true, alt: true });
      if (hit && t < 1180 && s.has("spark"))
        for (let i = 0; i < 5; i++) spawn(p, s.mid + 1, s.floor - 11, "spark", { spread: 2.4, life: 26 });
      if (hit && s.has("star")) s.at("star", s.mid, s.floor - 14);
    } },

  refute: { group: "verdict", dur: 2800, trigger: "verifier REFUTED", why: "Verification failed.",
    draw(s, t) {
      const u = easeOut(t / 1100), done = t > 1100;
      const gx = Math.round(s.W + 4 - (s.W + 4 - (s.mid + s.cw - 1)) * u);
      s.body(s.mid - Math.floor(s.cw / 2), s.floor, done ? "slump" : "stand");
      s.body(gx, s.floor, "stand", { flip: true, alt: true });
    } },

  trophy: { group: "verdict", dur: 2800, trigger: "goal gate passed", why: "A verifiable goal met its criteria.",
    draw(s, t) {
      const lift = easeOut(t / 700);
      const b = t > 700 ? Math.round(Math.abs(sin(t, 1.3))) : 0;
      s.body(s.mid, s.floor - b, s.pack.poses.hold ? "hold" : "stand");
      s.hold(s.mid, s.floor - b, s.has("trophy") ? "trophy" : "flag", { dy: -Math.round(lift * 4) });
    } },
};

export const stateNames = () => Object.keys(STATES);

/**
 * Context thresholds.
 *
 * These are CONVENTIONS, not measurements. No published figure says an agent degrades
 * at 55% or 85% of its window. They are set where a warning is still actionable:
 * 55% is "you can still finish this task", 85% is "start a fresh window now". Say so
 * wherever they are surfaced — a number that looks measured but isn't is worse than
 * no number.
 */
export const CTX_HAUL = 55;
export const CTX_STOP = 85;

/**
 * Live numbers outrank the last event, because a full window matters more than which
 * tool just ran. Pure function so the terminal and the SVG view cannot drift apart.
 */
export function stateFromHud(current, hud = {}) {
  if (!Number.isFinite(hud?.ctxPct)) return current;
  if (hud.ctxPct >= CTX_STOP) return "stopSign";
  if (hud.ctxPct >= CTX_HAUL && (current === "idle" || current === "patrol" || current === "haul")) return "haul";
  return current;
}

/**
 * Create an engine bound to one character pack.
 * `hud` carries live numbers ({ ctxPct, costUsd, burn }) and may be updated in place.
 */
export function createEngine(pack, { width = 40, height = 12, hud = {} } = {}) {
  const frame = new Frame(width, height);
  const particles = [];
  let current = "idle";
  let started = 0;

  return {
    frame,
    hud,
    get state() { return current; },

    setState(name, now = Date.now()) {
      if (!STATES[name]) throw new Error(`unknown state '${name}'. Known: ${stateNames().join(", ")}`);
      current = name;
      started = now;
      particles.length = 0;
      return this;
    },

    resize(w, h) {
      const f = new Frame(w, h);
      frame.w = f.w; frame.h = f.h; frame.px = f.px;
      return this;
    },

    /**
     * Advance to absolute time `now` and return ANSI lines.
     * Auto-derives a state from live numbers when `autoFromHud` is on: cost/context
     * pressure outranks whatever the last event was, because it matters more.
     */
    render(now = Date.now(), { autoFromHud = false, color = true } = {}) {
      if (autoFromHud) current = stateFromHud(current, hud);

      const st = STATES[current] ?? STATES.idle;
      let t = now - started;
      if (st.dur && t > st.dur) { current = "idle"; started = now; t = 0; }

      frame.clear();
      const s = scene(frame, pack, hud);

      // money leaves the creature at the burn rate — the rate is legible before the number
      const burn = Number(hud.burn) || 0;
      if (burn > 0 && s.has("coin")) {
        const every = Math.max(90, 640 - burn * 520);
        if (Math.floor(t / every) !== Math.floor((t - 40) / every))
          spawn(particles, s.mid + 2, s.floor - 9, burn > 0.62 && s.has("bill") && Math.random() < 0.5 ? "bill" : "coin", { life: 54 });
      }

      st.draw(s, t, particles);
      stepParticles(particles, s);

      return frame.toLines({ color });
    },
  };
}
