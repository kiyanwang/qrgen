import { createCanvas } from "@napi-rs/canvas";

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0–255 */
  a: number;
}

const probe = createCanvas(1, 1).getContext("2d");

/**
 * Parse any CSS colour (hex, rgb(), hsl(), named, "transparent") into RGBA.
 * Canvas silently ignores invalid fillStyle values, so an input is valid only
 * if it overrides two different sentinel colours.
 */
export function parseColor(input: string): Rgba {
  const value = input.trim();
  probe.fillStyle = "#010203";
  probe.fillStyle = value;
  const first = probe.fillStyle;
  probe.fillStyle = "#040506";
  probe.fillStyle = value;
  if (value === "" || first !== probe.fillStyle) {
    throw new Error(`Invalid colour: "${input}"`);
  }
  probe.clearRect(0, 0, 1, 1);
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = probe.getImageData(0, 0, 1, 1).data;
  return { r, g, b, a };
}

export function isValidColor(input: string): boolean {
  try {
    parseColor(input);
    return true;
  } catch {
    return false;
  }
}

/** WCAG relative luminance, ignoring alpha. */
export function luminance({ r, g, b }: Rgba): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
