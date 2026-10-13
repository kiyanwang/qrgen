import { createCanvas, type Canvas } from "@napi-rs/canvas";
import { parseColor, type Rgba } from "./color.ts";
import { buildMatrix } from "./matrix.ts";
import type { QrOptions } from "./options.ts";
import { renderCanvas, renderPng } from "./render.ts";

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 255 };
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 255 };

export interface PreviewOptions {
  /** Use the code's own colours (needs a truecolor terminal). */
  trueColor?: boolean;
  /** Plain characters, no escape codes (for NO_COLOR / pipes). */
  plain?: boolean;
}

export function supportsTrueColor(env = process.env): boolean {
  return /^(truecolor|24bit)$/i.test(env.COLORTERM ?? "");
}

/**
 * Render the code as text: each character cell holds two module rows using
 * "▀" with the top module as foreground and the bottom as background colour.
 * Always shown on its own quiet zone so it scans straight off the screen.
 */
export function renderTerminal(o: QrOptions, { trueColor = false, plain = false }: PreviewOptions = {}): string {
  const m = buildMatrix(o.data, o.ecl);
  const quiet = 2;
  const n = m.size + quiet * 2;
  const dark = (r: number, c: number) => m.isDark(r - quiet, c - quiet);

  if (plain) {
    // Light modules as blocks: reads correctly on the usual dark terminal theme.
    const glyph = ["█", "▀", "▄", " "];
    const lines: string[] = [];
    for (let r = 0; r < n; r += 2) {
      let line = "";
      for (let c = 0; c < n; c++) line += glyph[(dark(r, c) ? 2 : 0) + (r + 1 < n && dark(r + 1, c) ? 1 : 0)];
      lines.push(line);
    }
    return lines.join("\n");
  }

  let ink = BLACK;
  let paper = WHITE;
  if (trueColor) {
    ink = parseColor(o.gradient?.from ?? o.fg);
    const bg = parseColor(o.bg);
    paper = bg.a < 128 ? WHITE : bg;
  }
  const code = (c: Rgba, layer: 38 | 48) =>
    trueColor ? `\x1b[${layer};2;${c.r};${c.g};${c.b}m` : `\x1b[${layer};5;${c === BLACK ? 16 : 231}m`;

  const lines: string[] = [];
  for (let r = 0; r < n; r += 2) {
    let line = "";
    let fg: Rgba | undefined;
    let bg: Rgba | undefined;
    for (let c = 0; c < n; c++) {
      const top = dark(r, c) ? ink : paper;
      const bottom = r + 1 < n && dark(r + 1, c) ? ink : paper;
      // Only emit escape codes when a colour changes.
      if (top !== fg) line += code((fg = top), 38);
      if (bottom !== bg) line += code((bg = bottom), 48);
      line += "▀";
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join("\n");
}

export type ImageProtocol = "kitty" | "iterm";

/**
 * Which inline-image protocol the terminal speaks, from its environment.
 * QRGEN_PREVIEW=kitty|iterm|text overrides detection.
 */
export function detectImageProtocol(env: NodeJS.ProcessEnv = process.env): ImageProtocol | undefined {
  const forced = env.QRGEN_PREVIEW?.toLowerCase();
  if (forced) return forced === "kitty" || forced === "iterm" ? forced : undefined;
  // Multiplexers drop graphics escapes unless specially configured.
  if (env.TMUX || env.STY || env.ZELLIJ) return undefined;
  const term = env.TERM ?? "";
  const program = env.TERM_PROGRAM ?? "";
  if (term === "xterm-kitty" || env.KITTY_WINDOW_ID || term === "xterm-ghostty" || program === "ghostty" || program === "WezTerm") {
    return "kitty";
  }
  if (program === "iTerm.app" || env.LC_TERMINAL === "iTerm2") return "iterm";
  return undefined;
}

/** Escape sequence that draws a PNG inline, `rows` text lines tall (width follows the aspect ratio). */
export function inlineImage(png: Buffer, protocol: ImageProtocol, rows: number): string {
  const data = png.toString("base64");
  if (protocol === "iterm") {
    return `\x1b]1337;File=inline=1;size=${png.length};height=${rows};preserveAspectRatio=1:${data}\x07\n`;
  }
  return `${kittyEscapes(png, `a=T,f=100,q=2,r=${rows}`)}\n`;
}

/**
 * Kitty graphics protocol escapes carrying a PNG in 4096-byte chunks, with
 * `control` on the first. Callers should include q=2: it suppresses the
 * terminal's reply, which would otherwise arrive on stdin as keystrokes.
 */
export function kittyEscapes(png: Buffer, control: string): string {
  const chunks = png.toString("base64").match(/.{1,4096}/g) ?? [];
  return chunks
    .map((chunk, i) => {
      const more = i < chunks.length - 1 ? 1 : 0;
      return `\x1b_G${i === 0 ? `${control},` : ""}m=${more};${chunk}\x1b\\`;
    })
    .join("");
}

/** The code as shown on screen: a transparent background sits on a light checkerboard. */
export async function previewCanvas(o: QrOptions, size: number): Promise<Canvas> {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  if (parseColor(o.bg).a < 255) {
    const tile = Math.max(3, Math.round(size / 40));
    for (let y = 0; y < size; y += tile) {
      for (let x = 0; x < size; x += tile) {
        ctx.fillStyle = (x / tile + y / tile) % 2 ? "#d4d4d8" : "#f4f4f5";
        ctx.fillRect(x, y, tile, tile);
      }
    }
  }
  ctx.drawImage(await renderCanvas({ ...o, size }), 0, 0);
  return canvas;
}

export async function previewPng(o: QrOptions, size: number): Promise<Buffer> {
  return (await previewCanvas(o, size)).encode("png");
}

export interface PixelGrid {
  size: number;
  /** "#rrggbb" of the pixel at (x, y). */
  at(x: number, y: number): string;
}

/** The preview sampled at `px`×`px` pixels, for drawing with half-block characters. */
export async function pixelGrid(o: QrOptions, px: number): Promise<PixelGrid> {
  const canvas = await previewCanvas({ ...o, margin: Math.min(o.margin, 2) }, px);
  const { data } = canvas.getContext("2d").getImageData(0, 0, px, px);
  const hex = (v: number) => v.toString(16).padStart(2, "0");
  return {
    size: px,
    at(x, y) {
      const i = (y * px + x) * 4;
      return `#${hex(data[i]!)}${hex(data[i + 1]!)}${hex(data[i + 2]!)}`;
    },
  };
}

/**
 * Downsample the real rendered image into half-block "pixels" so shapes,
 * gradients and logos show (roughly) in any truecolor terminal.
 */
export async function renderPixels(o: QrOptions, maxCols: number): Promise<string> {
  const total = buildMatrix(o.data, o.ecl).size + Math.min(o.margin, 2) * 2;
  // Three pixels per module is the least that tells a dot from a square.
  const scale = Math.max(1, Math.min(3, Math.floor(maxCols / total)));
  const px = total * scale;
  const grid = await pixelGrid(o, px);
  const pixel = (x: number, y: number) => {
    const hex = y < px ? grid.at(x, y) : "#ffffff";
    return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)).join(";");
  };
  const lines: string[] = [];
  for (let y = 0; y < px; y += 2) {
    let line = "";
    let fg = "";
    let bg = "";
    for (let x = 0; x < px; x++) {
      const top = pixel(x, y);
      const bottom = pixel(x, y + 1);
      if (top !== fg) line += `\x1b[38;2;${(fg = top)}m`;
      if (bottom !== bg) line += `\x1b[48;2;${(bg = bottom)}m`;
      line += "▀";
    }
    lines.push(`${line}\x1b[0m`);
  }
  return lines.join("\n");
}

export interface LivePreviewOptions {
  /** Without inline images: "pixels" shows shapes approximately, "modules" stays scannable. */
  fallback: "pixels" | "modules";
  env?: NodeJS.ProcessEnv;
  columns?: number;
  rows?: number;
}

/** The most faithful preview this terminal can show. */
export async function livePreview(o: QrOptions, opts: LivePreviewOptions): Promise<string> {
  const { env = process.env, columns = process.stdout.columns || 80, rows = process.stdout.rows || 40 } = opts;
  const protocol = detectImageProtocol(env);
  if (protocol) {
    // Leave room below for the settings summary and menu.
    const height = Math.max(10, Math.min(24, rows - 24));
    return inlineImage(await renderPng({ ...o, size: 480 }), protocol, height);
  }
  const trueColor = supportsTrueColor(env);
  if (opts.fallback === "pixels" && trueColor) return renderPixels(o, columns - 4);
  return renderTerminal(o, { trueColor });
}
