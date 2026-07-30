// Terminal renderer.
//
// A cell is twice as tall as it is wide, so drawing one sprite pixel per cell
// makes everything look stretched. Instead each cell carries TWO vertical pixels
// using a half-block glyph: foreground paints the top half, background the bottom.
// That yields square pixels and doubles vertical resolution.
//
//   both pixels set  -> "▀" fg=top bg=bottom
//   top only         -> "▀" fg=top
//   bottom only      -> "▄" fg=bottom
//   neither          -> " "

const UPPER = "▀"; // ▀
const LOWER = "▄"; // ▄
const RESET = "\x1b[0m";

export const supportsColor = () =>
  process.env.FORCE_COLOR !== "0" &&
  !process.env.NO_COLOR &&
  (process.stdout.isTTY || process.env.FORCE_COLOR === "1");

const hexCache = new Map();
function rgb(hex) {
  let v = hexCache.get(hex);
  if (!v) {
    v = [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    hexCache.set(hex, v);
  }
  return v;
}
const fg = (hex) => { const [r, g, b] = rgb(hex); return `\x1b[38;2;${r};${g};${b}m`; };
const bg = (hex) => { const [r, g, b] = rgb(hex); return `\x1b[48;2;${r};${g};${b}m`; };

/**
 * A pixel buffer in sprite space. Origin top-left, y grows downward.
 * Cells hold a hex colour string or null for transparent.
 */
export class Frame {
  constructor(width, height) {
    this.w = Math.max(1, width | 0);
    this.h = Math.max(2, height | 0);
    if (this.h % 2) this.h++;            // half-blocks need an even row count
    this.px = new Array(this.w * this.h).fill(null);
  }

  clear() { this.px.fill(null); return this; }

  set(x, y, color) {
    x |= 0; y |= 0;
    if (!color || x < 0 || y < 0 || x >= this.w || y >= this.h) return this;
    this.px[y * this.w + x] = color;
    return this;
  }

  get(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    return this.px[y * this.w + x];
  }

  rect(x, y, w, h, color) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, color);
    return this;
  }

  /**
   * Stamp a character grid. `palette` maps grid chars to hex; '.' and ' ' are transparent.
   * `flip` mirrors horizontally, which is how the creature turns around.
   */
  blit(grid, palette, x, y, { flip = false } = {}) {
    const w = grid[0].length;
    for (let j = 0; j < grid.length; j++) {
      const row = grid[j];
      for (let i = 0; i < row.length; i++) {
        const ch = row[i];
        if (ch === "." || ch === " ") continue;
        const c = palette[ch];
        if (!c) continue;
        this.set(x + (flip ? w - 1 - i : i), y + j, c);
      }
    }
    return this;
  }

  /** Render to an array of ANSI strings, one per terminal row (h/2 rows). */
  toLines({ color = true } = {}) {
    const lines = [];
    for (let y = 0; y < this.h; y += 2) {
      let out = "";
      let curFg = null, curBg = null;
      for (let x = 0; x < this.w; x++) {
        const top = this.get(x, y), bot = this.get(x, y + 1);
        if (!color) { out += top || bot ? "#" : " "; continue; }
        if (!top && !bot) {
          if (curFg || curBg) { out += RESET; curFg = curBg = null; }
          out += " ";
          continue;
        }
        if (top && bot) {
          if (curFg !== top) { out += fg(top); curFg = top; }
          if (curBg !== bot) { out += bg(bot); curBg = bot; }
          out += UPPER;
        } else if (top) {
          if (curBg) { out += RESET; curFg = curBg = null; }
          if (curFg !== top) { out += fg(top); curFg = top; }
          out += UPPER;
        } else {
          if (curBg) { out += RESET; curFg = curBg = null; }
          if (curFg !== bot) { out += fg(bot); curFg = bot; }
          out += LOWER;
        }
      }
      if (curFg || curBg) out += RESET;
      lines.push(out);
    }
    return lines;
  }
}

/**
 * In-place animation surface. Prints `rows` blank lines once, then rewinds and
 * redraws on every frame. No dependency, no alternate screen buffer — so scrollback
 * survives and Ctrl-C leaves the terminal usable.
 */
export class Surface {
  constructor(rows) {
    this.rows = rows;
    this.started = false;
    this.out = process.stdout;
  }

  start() {
    if (this.started) return;
    this.out.write("\x1b[?25l");                    // hide cursor
    this.out.write("\n".repeat(this.rows));
    this.started = true;
  }

  draw(lines) {
    this.start();
    let buf = `\x1b[${this.rows}A`;                 // rewind
    for (let i = 0; i < this.rows; i++) {
      buf += "\x1b[2K" + (lines[i] ?? "") + "\n";   // clear line, then content
    }
    this.out.write(buf);
  }

  stop() {
    if (!this.started) return;
    this.out.write("\x1b[?25h");                    // show cursor
    this.started = false;
  }
}
