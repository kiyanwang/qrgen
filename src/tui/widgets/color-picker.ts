import { contrastRatio, parseColor } from "../../color.ts";
import { cssToHex, hsvHex, hsvToRgb, readableOn, rgbToHsv, toHex, type Hsv, type Rgb } from "../colorspace.ts";
import type { KeyEvent, MouseEvent } from "../input.ts";
import { contains, type Rect, type Screen } from "../screen.ts";
import { theme } from "../theme.ts";
import type { Dialog } from "./dialog.ts";
import { TextInput } from "./text-input.ts";

/** Dark row suits foregrounds, light row suits backgrounds. */
export const PALETTE: string[][] = [
  ["#000000", "#1f2937", "#b91c1c", "#c2410c", "#a16207", "#15803d", "#0f766e", "#0369a1", "#1d4ed8", "#4338ca", "#6d28d9", "#be185d"],
  ["#ffffff", "#f3f4f6", "#fecaca", "#fed7aa", "#fde68a", "#bbf7d0", "#99f6e4", "#bae6fd", "#bfdbfe", "#c7d2fe", "#ddd6fe", "#fbcfe8"],
];

export interface ColorPickerOptions {
  title: string;
  /** Any CSS colour, or "transparent". */
  initial: string;
  allowTransparent?: boolean;
  /** Colour to show contrast against, e.g. the background when picking the foreground. */
  against?: { color: string; label: string };
  /** Called on every change, for a live preview. */
  onChange(value: string): void;
  /** The chosen colour as "#rrggbb" / "transparent", or undefined if cancelled. */
  onDone(value: string | undefined): void;
}

type Field = "wheel" | "value" | "text" | "r" | "g" | "b" | "palette" | "transparent";
const CHANNELS = ["r", "g", "b"] as const;
const BAR = 16;

interface Geometry {
  R: number;
  wheel: Rect;
  value: Rect;
  swatches: Rect;
  text: Rect;
  sliders: Record<"r" | "g" | "b", Rect>;
  palette: Rect;
  transparent?: Rect;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class ColorPicker implements Dialog {
  readonly title: string;
  private hsv: Hsv;
  private transparent: boolean;
  private readonly original: string;
  private focus: Field = "wheel";
  private readonly input: TextInput;
  private paletteAt = { row: 0, col: 0 };
  private drag: Field | undefined;
  private geom: Geometry | undefined;

  private readonly o: ColorPickerOptions;

  constructor(o: ColorPickerOptions) {
    this.o = o;
    this.title = o.title;
    const isTransparent = o.initial.trim().toLowerCase() === "transparent";
    const hex = (isTransparent ? undefined : cssToHex(o.initial)) ?? "#000000";
    this.hsv = rgbToHsv(hexToRgb(hex));
    this.transparent = Boolean(o.allowTransparent) && isTransparent;
    this.original = this.transparent ? "transparent" : hex;
    this.input = new TextInput(this.transparent ? "transparent" : hex);
    const match = PALETTE.flatMap((row, r) => row.map((c, col) => ({ c, r, col }))).find((p) => p.c === hex);
    if (match) this.paletteAt = { row: match.r, col: match.col };
  }

  get value(): string {
    return this.transparent ? "transparent" : this.hex;
  }

  private get hex(): string {
    return hsvHex(this.hsv);
  }

  private get fields(): Field[] {
    return ["wheel", "value", "text", "r", "g", "b", "palette", ...(this.o.allowTransparent ? (["transparent"] as const) : [])];
  }

  // ---- state changes -------------------------------------------------------

  private setHsv(next: Hsv, fromText = false) {
    this.hsv = { h: (next.h + 360) % 360, s: clamp(next.s, 0, 1), v: clamp(next.v, 0, 1) };
    this.transparent = false;
    if (!fromText) this.input.set(this.hex);
    this.o.onChange(this.value);
  }

  /** Set from RGB, keeping hue/saturation where RGB can't express them (greys, black). */
  private setRgb(rgb: Rgb, fromText = false) {
    const next = rgbToHsv(rgb);
    if (next.v === 0) {
      next.h = this.hsv.h;
      next.s = this.hsv.s;
    } else if (next.s === 0) next.h = this.hsv.h;
    this.setHsv(next, fromText);
  }

  private setTransparent(on: boolean) {
    this.transparent = on;
    this.input.set(on ? "transparent" : this.hex);
    this.o.onChange(this.value);
  }

  private setChannel(ch: "r" | "g" | "b", value: number) {
    this.setRgb({ ...hsvToRgb(this.hsv), [ch]: clamp(Math.round(value), 0, 255) });
  }

  /** Pick the colour at a point on the wheel, in wheel pixel coordinates. */
  private pickWheel(px: number, py: number) {
    const R = this.geom?.R ?? 13;
    const dx = px - R;
    const dy = py - R;
    const s = Math.min(1, Math.hypot(dx, dy) / R);
    const h = s === 0 ? this.hsv.h : (Math.atan2(-dy, dx) * 180) / Math.PI;
    this.setHsv({ h, s, v: this.hsv.v || 1 });
  }

  private wheelPoint(): [number, number] {
    const R = this.geom?.R ?? 13;
    const a = (this.hsv.h * Math.PI) / 180;
    return [R + this.hsv.s * R * Math.cos(a), R - this.hsv.s * R * Math.sin(a)];
  }

  // ---- input ---------------------------------------------------------------

  key(e: KeyEvent) {
    if (e.name === "escape") return this.o.onDone(undefined);
    if (e.name === "enter") return this.o.onDone(this.value);
    if (e.name === "tab") return this.cycle(e.shift ? -1 : 1);

    if (this.focus === "text") {
      if (this.input.handleKey(e) === "changed") {
        const typed = this.input.value.trim();
        if (this.o.allowTransparent && typed.toLowerCase() === "transparent") this.setTransparent(true);
        else {
          const hex = cssToHex(typed);
          if (hex) this.setRgb(hexToRgb(hex), true);
        }
      } else if (e.name === "up" || e.name === "down") this.cycle(e.name === "up" ? -1 : 1);
      return;
    }

    const big = e.shift;
    if (e.name === "char" && (e.ch === "[" || e.ch === "]")) {
      return this.setHsv({ ...this.hsv, v: this.hsv.v + (e.ch === "]" ? 0.05 : -0.05) });
    }

    switch (this.focus) {
      case "wheel": {
        const d: Record<string, [number, number]> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
        const step = d[e.name];
        if (step) {
          const [x, y] = this.wheelPoint();
          const n = big ? 4 : 1;
          this.pickWheel(Math.round(x) + step[0] * n, Math.round(y) + step[1] * n);
        }
        break;
      }
      case "value":
        if (e.name === "up" || e.name === "right") this.setHsv({ ...this.hsv, v: this.hsv.v + (big ? 0.1 : 0.02) });
        if (e.name === "down" || e.name === "left") this.setHsv({ ...this.hsv, v: this.hsv.v - (big ? 0.1 : 0.02) });
        break;
      case "r":
      case "g":
      case "b": {
        const cur = hsvToRgb(this.hsv)[this.focus];
        if (e.name === "left" || e.name === "right") this.setChannel(this.focus, cur + (e.name === "right" ? 1 : -1) * (big ? 16 : 1));
        else if (e.name === "pageup" || e.name === "pagedown") this.setChannel(this.focus, cur + (e.name === "pageup" ? 16 : -16));
        else if (e.name === "home" || e.name === "end") this.setChannel(this.focus, e.name === "end" ? 255 : 0);
        else if (e.name === "up" || e.name === "down") this.cycle(e.name === "up" ? -1 : 1);
        break;
      }
      case "palette": {
        const { row, col } = this.paletteAt;
        if (e.name === "left") this.choosePalette(row, (col + 11) % 12);
        if (e.name === "right") this.choosePalette(row, (col + 1) % 12);
        if (e.name === "up" || e.name === "down") this.choosePalette(1 - row, col);
        if (e.name === "char" && e.ch === " ") this.choosePalette(row, col);
        break;
      }
      case "transparent":
        if (e.name === "char" && e.ch === " ") this.setTransparent(!this.transparent);
        else if (e.name === "up" || e.name === "down") this.cycle(e.name === "up" ? -1 : 1);
        break;
    }
  }

  private cycle(dir: 1 | -1) {
    const f = this.fields;
    this.focus = f[(f.indexOf(this.focus) + dir + f.length) % f.length]!;
  }

  private choosePalette(row: number, col: number) {
    this.paletteAt = { row, col };
    this.setRgb(hexToRgb(PALETTE[row]![col]!));
  }

  paste(text: string) {
    this.focus = "text";
    this.input.set("");
    this.input.insert(text.trim());
    const hex = cssToHex(this.input.value);
    if (hex) this.setRgb(hexToRgb(hex), true);
  }

  mouse(e: MouseEvent) {
    const g = this.geom;
    if (!g) return;
    if (e.action === "up") {
      this.drag = undefined;
      return;
    }
    if (e.action === "wheelup" || e.action === "wheeldown") {
      const dir = e.action === "wheelup" ? 1 : -1;
      if (contains(g.value, e.x, e.y) || contains(g.wheel, e.x, e.y)) this.setHsv({ ...this.hsv, v: this.hsv.v + dir * 0.02 });
      for (const ch of CHANNELS) {
        if (contains(g.sliders[ch], e.x, e.y)) this.setChannel(ch, hsvToRgb(this.hsv)[ch] + dir * 4);
      }
      return;
    }
    if (e.button !== "left") return;

    const target =
      e.action === "drag" && this.drag
        ? this.drag
        : e.action === "down"
          ? this.hit(e.x, e.y)
          : undefined;
    if (!target) return;
    if (e.action === "down") this.drag = target;

    switch (target) {
      case "wheel": {
        const px = e.x - g.wheel.x;
        const py = (e.y - g.wheel.y) * 2 + 0.5;
        if (e.action === "down" && Math.hypot(px - g.R, py - g.R) > g.R + 1.5) {
          this.drag = undefined;
          return;
        }
        this.focus = "wheel";
        this.pickWheel(px, py);
        break;
      }
      case "value": {
        this.focus = "value";
        const py = (e.y - g.value.y) * 2 + 0.5;
        this.setHsv({ ...this.hsv, v: 1 - py / (g.value.h * 2 - 1) });
        break;
      }
      case "r":
      case "g":
      case "b": {
        this.focus = target;
        const bar = g.sliders[target];
        this.setChannel(target, (clamp(e.x - bar.x, 0, BAR - 1) / (BAR - 1)) * 255);
        break;
      }
      case "palette": {
        const dx = e.x - g.palette.x;
        const col = Math.floor(dx / 3);
        const row = e.y - g.palette.y;
        if (dx % 3 === 2 || col > 11 || row > 1) return;
        this.focus = "palette";
        this.choosePalette(row, col);
        break;
      }
      case "text":
        this.focus = "text";
        this.input.clickAt(e.x - g.text.x);
        break;
      case "transparent":
        if (e.action === "down") {
          this.focus = "transparent";
          this.setTransparent(!this.transparent);
        }
        break;
    }
  }

  private hit(x: number, y: number): Field | undefined {
    const g = this.geom!;
    if (contains(g.wheel, x, y)) return "wheel";
    if (contains({ ...g.value, w: g.value.w + 1 }, x, y)) return "value";
    if (contains(g.text, x, y)) return "text";
    for (const ch of CHANNELS) if (contains(g.sliders[ch], x, y)) return ch;
    if (contains(g.palette, x, y)) return "palette";
    if (g.transparent && contains(g.transparent, x, y)) return "transparent";
    return undefined;
  }

  // ---- layout & drawing ----------------------------------------------------

  private static radius(maxH: number) {
    return clamp(maxH - 6, 10, 13);
  }

  size(_maxW: number, maxH: number) {
    const R = ColorPicker.radius(maxH);
    return { w: 2 * R + 1 + 35, h: R + 6 };
  }

  private layout(inner: Rect): Geometry {
    const R = ColorPicker.radius(inner.h + 2);
    const D = 2 * R + 1;
    const x0 = inner.x + 1;
    const y0 = inner.y;
    const right = x0 + D + 7;
    return {
      R,
      wheel: { x: x0, y: y0, w: D, h: R + 1 },
      value: { x: x0 + D + 2, y: y0, w: 2, h: R + 1 },
      swatches: { x: right, y: y0 + 1, w: 22, h: 2 },
      text: { x: right, y: y0 + 5, w: 22, h: 1 },
      sliders: {
        r: { x: right + 2, y: y0 + 7, w: BAR, h: 1 },
        g: { x: right + 2, y: y0 + 8, w: BAR, h: 1 },
        b: { x: right + 2, y: y0 + 9, w: BAR, h: 1 },
      },
      palette: { x: x0, y: y0 + R + 2, w: 36, h: 2 },
      transparent: this.o.allowTransparent ? { x: right, y: y0 + 14, w: 17, h: 1 } : undefined,
    };
  }

  render(s: Screen, inner: Rect) {
    const g = (this.geom = this.layout(inner));
    const bg = theme.dialog;
    const label = (f: Field) => ({ fg: this.focus === f ? theme.accent : theme.dim, bold: this.focus === f, bg });

    this.drawWheel(s, g);
    this.drawValueBar(s, g);

    // New / was swatches.
    const sw = g.swatches;
    s.text(sw.x, sw.y - 1, "New", { fg: theme.dim, bg });
    s.text(sw.x + 12, sw.y - 1, "Was", { fg: theme.dim, bg });
    drawSwatch(s, { x: sw.x, y: sw.y, w: 10, h: 2 }, this.value);
    drawSwatch(s, { x: sw.x + 12, y: sw.y, w: 10, h: 2 }, this.original);

    s.text(g.text.x, g.text.y - 1, "Hex or CSS name", label("text"));
    this.input.render(s, g.text.x, g.text.y, g.text.w, this.focus === "text");

    const rgb = hsvToRgb(this.hsv);
    for (const ch of CHANNELS) {
      const bar = g.sliders[ch];
      s.text(bar.x - 2, bar.y, ch.toUpperCase(), label(ch));
      const knob = Math.round((rgb[ch] / 255) * (BAR - 1));
      for (let k = 0; k < BAR; k++) {
        const c = toHex({ ...rgb, [ch]: Math.round((k / (BAR - 1)) * 255) });
        s.put(bar.x + k, bar.y, k === knob ? "●" : " ", { fg: readableOn(c), bg: c });
      }
      s.text(bar.x + BAR + 1, bar.y, String(rgb[ch]).padStart(3), { fg: theme.text, bg });
    }

    const { h, s: sat, v } = this.hsv;
    s.text(g.text.x, g.sliders.b.y + 2, `H ${Math.round(h)}°  S ${Math.round(sat * 100)}%  V ${Math.round(v * 100)}%`, {
      fg: theme.dim,
      bg,
    });
    this.drawContrast(s, g.text.x, g.sliders.b.y + 3);

    if (g.transparent) {
      s.text(g.transparent.x, g.transparent.y, `[${this.transparent ? "x" : " "}] Transparent`, label("transparent"));
    }

    // Palette.
    s.text(g.palette.x, g.palette.y - 1, "", { bg });
    PALETTE.forEach((row, r) =>
      row.forEach((c, col) => {
        const x = g.palette.x + col * 3;
        const y = g.palette.y + r;
        const selected = this.focus === "palette" && this.paletteAt.row === r && this.paletteAt.col === col;
        s.put(x, y, selected ? "▐" : " ", { fg: theme.accent, bg: c });
        s.put(x + 1, y, selected ? "▌" : " ", { fg: theme.accent, bg: c });
      }),
    );
  }

  private drawWheel(s: Screen, g: Geometry) {
    const { R } = g;
    const bg = theme.dialog;
    const pixel = (i: number, j: number): string | undefined => {
      const dx = i - R;
      const dy = j - R;
      const d = Math.hypot(dx, dy);
      if (d > R + 0.5) return undefined;
      return hsvHex({ h: (Math.atan2(-dy, dx) * 180) / Math.PI + 360, s: Math.min(1, d / R), v: this.hsv.v });
    };
    for (let row = 0; row < g.wheel.h; row++) {
      for (let i = 0; i < g.wheel.w; i++) {
        const top = pixel(i, row * 2);
        const bottom = pixel(i, row * 2 + 1);
        const x = g.wheel.x + i;
        const y = g.wheel.y + row;
        if (top) s.put(x, y, "▀", { fg: top, bg: bottom ?? bg });
        else if (bottom) s.put(x, y, "▄", { fg: bottom, bg });
      }
    }
    const [px, py] = this.wheelPoint();
    const hex = this.hex;
    s.put(g.wheel.x + Math.round(px), g.wheel.y + Math.floor(Math.round(py) / 2), this.focus === "wheel" ? "◆" : "◇", {
      fg: readableOn(hex),
      bg: hex,
    });
  }

  private drawValueBar(s: Screen, g: Geometry) {
    const span = g.value.h * 2 - 1;
    const at = (j: number) => hsvHex({ ...this.hsv, v: 1 - j / span });
    for (let row = 0; row < g.value.h; row++) {
      for (let k = 0; k < g.value.w; k++) {
        s.put(g.value.x + k, g.value.y + row, "▀", { fg: at(row * 2), bg: at(row * 2 + 1) });
      }
    }
    const row = Math.floor(Math.round((1 - this.hsv.v) * span) / 2);
    s.put(g.value.x + g.value.w, g.value.y + row, "◀", {
      fg: this.focus === "value" ? theme.accent : theme.dim,
      bg: theme.dialog,
    });
  }

  private drawContrast(s: Screen, x: number, y: number) {
    const against = this.o.against;
    const bg = theme.dialog;
    if (!against || this.transparent || against.color.trim().toLowerCase() === "transparent") return;
    let ratio: number;
    try {
      ratio = contrastRatio(parseColor(this.hex), parseColor(against.color));
    } catch {
      return;
    }
    const [mark, fg] = ratio >= 4 ? ["✔ good", theme.ok] : ratio >= 3 ? ["~ fair", theme.warn] : ["✖ low", theme.error];
    s.text(x, y, `Contrast vs ${against.label}`, { fg: theme.dim, bg }, 22);
    s.text(x, y + 1, `${ratio.toFixed(1)}:1 ${mark}`, { fg, bg }, 22);
  }

  hints() {
    const common = "Tab next · Enter OK · Esc cancel";
    switch (this.focus) {
      case "wheel":
        return `←↑↓→ hue & saturation · [ ] brightness · click/drag · ${common}`;
      case "value":
        return `↑↓ brightness · click/drag · ${common}`;
      case "text":
        return `type #hex or a name like teal · ${common}`;
      case "palette":
        return `←→↑↓ choose swatch · ${common}`;
      case "transparent":
        return `Space toggle transparent · ${common}`;
      default:
        return `←→ ±1 · Shift+←→ ±16 · ↑↓ field · ${common}`;
    }
  }
}

function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** A colour block, or a checkerboard for transparent. */
export function drawSwatch(s: Screen, r: Rect, color: string) {
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      if (color === "transparent") {
        const odd = (x + y) % 2 === 1;
        s.put(x, y, "▀", { fg: odd ? "#9ca3af" : "#e5e7eb", bg: odd ? "#e5e7eb" : "#9ca3af" });
      } else s.put(x, y, " ", { bg: color });
    }
  }
}
