/** A cell-buffer screen: draw into it, then emit only what changed since the last frame. */

export interface Style {
  /** "#rrggbb"; undefined inherits the existing background for text, or the terminal default for fills. */
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Cell {
  ch: string;
  fg?: string;
  bg?: string;
  attrs: number;
}

const BOLD = 1;
const DIM = 2;
const ITALIC = 4;
const UNDERLINE = 8;

const attrsOf = (s: Style) =>
  (s.bold ? BOLD : 0) | (s.dim ? DIM : 0) | (s.italic ? ITALIC : 0) | (s.underline ? UNDERLINE : 0);

export const contains = (r: Rect, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

export class Screen {
  readonly cells: Cell[];
  readonly width: number;
  readonly height: number;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = Array.from({ length: width * height }, () => ({ ch: " ", attrs: 0 }));
  }

  cell(x: number, y: number): Cell | undefined {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return undefined;
    return this.cells[y * this.width + x];
  }

  /** Write one character. An undefined background keeps whatever is already there. */
  put(x: number, y: number, ch: string, style: Style = {}) {
    const c = this.cell(x, y);
    if (!c) return;
    c.ch = ch;
    c.fg = style.fg;
    if (style.bg !== undefined) c.bg = style.bg;
    c.attrs = attrsOf(style);
  }

  /** Write text, truncating with "…" past maxWidth. Returns the number of columns used. */
  text(x: number, y: number, str: string, style: Style = {}, maxWidth = Infinity): number {
    let chars = [...str];
    const limit = Math.min(maxWidth, this.width - x);
    if (limit <= 0) return 0;
    if (chars.length > limit) chars = [...chars.slice(0, limit - 1), "…"];
    chars.forEach((ch, i) => this.put(x + i, y, ch, style));
    return chars.length;
  }

  fill(r: Rect, style: Style = {}, ch = " ") {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        const c = this.cell(x, y);
        if (!c) continue;
        c.ch = ch;
        c.fg = style.fg;
        c.bg = style.bg;
        c.attrs = attrsOf(style);
      }
    }
  }

  box(r: Rect, opts: { border: Style; title?: string; titleStyle?: Style; fill?: Style }) {
    if (r.w < 2 || r.h < 2) return;
    if (opts.fill) this.fill(r, opts.fill);
    const b = opts.border;
    const right = r.x + r.w - 1;
    const bottom = r.y + r.h - 1;
    for (let x = r.x + 1; x < right; x++) {
      this.put(x, r.y, "─", b);
      this.put(x, bottom, "─", b);
    }
    for (let y = r.y + 1; y < bottom; y++) {
      this.put(r.x, y, "│", b);
      this.put(right, y, "│", b);
    }
    this.put(r.x, r.y, "╭", b);
    this.put(right, r.y, "╮", b);
    this.put(r.x, bottom, "╰", b);
    this.put(right, bottom, "╯", b);
    if (opts.title) this.text(r.x + 2, r.y, ` ${opts.title} `, opts.titleStyle ?? b, r.w - 4);
  }

  /** Plain text of one row, for tests. */
  row(y: number): string {
    let s = "";
    for (let x = 0; x < this.width; x++) s += this.cell(x, y)!.ch;
    return s;
  }

  toString(): string {
    return Array.from({ length: this.height }, (_, y) => this.row(y).trimEnd()).join("\n");
  }
}

export type ColorMode = "truecolor" | "256";

function rgbOf(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Nearest xterm-256 colour, for terminals without 24-bit colour (e.g. Apple Terminal). */
function to256([r, g, b]: [number, number, number]): number {
  const level = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.floor((v - 35) / 40));
  const cube = 16 + 36 * level(r) + 6 * level(g) + level(b);
  const steps = [0, 95, 135, 175, 215, 255];
  const cubeRgb = [steps[level(r)]!, steps[level(g)]!, steps[level(b)]!];
  const grey = Math.min(23, Math.max(0, Math.round(((r + g + b) / 3 - 8) / 10)));
  const greyV = 8 + grey * 10;
  const dist = (c: number[]) => (c[0]! - r) ** 2 + (c[1]! - g) ** 2 + (c[2]! - b) ** 2;
  return dist([greyV, greyV, greyV]) < dist(cubeRgb) ? 232 + grey : cube;
}

function sgr(c: Cell, mode: ColorMode): string {
  let s = "\x1b[0";
  if (c.attrs & BOLD) s += ";1";
  if (c.attrs & DIM) s += ";2";
  if (c.attrs & ITALIC) s += ";3";
  if (c.attrs & UNDERLINE) s += ";4";
  const color = (hex: string, layer: 38 | 48) =>
    mode === "truecolor" ? `;${layer};2;${rgbOf(hex).join(";")}` : `;${layer};5;${to256(rgbOf(hex))}`;
  if (c.fg) s += color(c.fg, 38);
  if (c.bg) s += color(c.bg, 48);
  return `${s}m`;
}

const same = (a: Cell, b: Cell) => a.ch === b.ch && a.fg === b.fg && a.bg === b.bg && a.attrs === b.attrs;

/** Escape sequences that turn `prev` into `next` (a full paint when prev is missing or a different size). */
export function diff(prev: Screen | undefined, next: Screen, mode: ColorMode = "truecolor"): string {
  const full = !prev || prev.width !== next.width || prev.height !== next.height;
  let out = "";
  for (let y = 0; y < next.height; y++) {
    let x = 0;
    while (x < next.width) {
      const cell = next.cell(x, y)!;
      if (!full && same(cell, prev.cell(x, y)!)) {
        x++;
        continue;
      }
      out += `\x1b[${y + 1};${x + 1}H`;
      let style = "";
      while (x < next.width) {
        const c = next.cell(x, y)!;
        if (!full && same(c, prev.cell(x, y)!)) break;
        const s = sgr(c, mode);
        if (s !== style) out += style = s;
        out += c.ch;
        x++;
      }
    }
  }
  return out ? `${out}\x1b[0m` : "";
}
