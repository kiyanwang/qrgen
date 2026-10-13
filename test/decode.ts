import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import jsQRModule from "jsqr";

// jsqr is CommonJS with an ES-style default export; normalise for nodenext typing.
const jsQR = ((jsQRModule as unknown as { default?: unknown }).default ?? jsQRModule) as typeof jsQRModule.default;

/** Decode a PNG with an independent QR reader; returns null if unreadable. */
export async function decodePng(png: Buffer): Promise<string | null> {
  const img = await loadImage(png);
  const ctx = createCanvas(img.width, img.height).getContext("2d");
  // Flatten onto white so transparent backgrounds decode like they would on paper.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, img.width, img.height);
  ctx.drawImage(img, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, img.width, img.height);
  return jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height)?.data ?? null;
}

/** Set QR_SAMPLES_DIR to keep rendered images for eyeballing. */
export function keepSample(name: string, png: Buffer) {
  const dir = process.env.QR_SAMPLES_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.png`), png);
}
