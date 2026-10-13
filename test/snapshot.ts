import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import type { Screen } from "../src/tui/screen.ts";

const CW = 10;
const CH = 20;

/** Paint a screen buffer as an image, approximating a terminal, for eyeballing layouts. */
export function screenToPng(s: Screen, defaultBg = "#000000", defaultFg = "#cccccc"): Buffer {
  const canvas = createCanvas(s.width * CW, s.height * CH);
  const ctx = canvas.getContext("2d");
  ctx.font = `${CH * 0.75}px Menlo, monospace`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const c = s.cell(x, y)!;
      const fg = c.fg ?? defaultFg;
      ctx.fillStyle = c.bg ?? defaultBg;
      ctx.fillRect(x * CW, y * CH, CW, CH);
      ctx.fillStyle = fg;
      if (c.ch === "▀") ctx.fillRect(x * CW, y * CH, CW, CH / 2);
      else if (c.ch === "▄") ctx.fillRect(x * CW, y * CH + CH / 2, CW, CH / 2);
      else if (c.ch === "█") ctx.fillRect(x * CW, y * CH, CW, CH);
      else if (c.ch !== " ") ctx.fillText(c.ch, x * CW + CW / 2, y * CH + CH / 2);
    }
  }
  return canvas.toBuffer("image/png");
}

/** Write a snapshot when QR_SAMPLES_DIR is set. */
export function keepScreen(name: string, s: Screen) {
  const dir = process.env.QR_SAMPLES_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.png`), screenToPng(s));
}
