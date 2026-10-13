import { contrastRatio, luminance, parseColor } from "./color.ts";

export const MODULE_STYLES = ["square", "dots", "rounded"] as const;
export const EYE_STYLES = ["square", "rounded", "circle"] as const;
export const GRADIENT_TYPES = ["linear", "radial"] as const;
export const ERROR_LEVELS = ["L", "M", "Q", "H"] as const;

export type ModuleStyle = (typeof MODULE_STYLES)[number];
export type EyeStyle = (typeof EYE_STYLES)[number];
export type GradientType = (typeof GRADIENT_TYPES)[number];
export type ErrorLevel = (typeof ERROR_LEVELS)[number];

export interface Gradient {
  type: GradientType;
  from: string;
  to: string;
  /** Degrees, linear only. 0 = left→right, 90 = top→bottom. */
  angle: number;
}

/** Fully resolved render settings. */
export interface QrOptions {
  /** Final content to encode. */
  data: string;
  /** Output width/height in pixels. */
  size: number;
  /** Quiet zone, in modules. */
  margin: number;
  ecl: ErrorLevel;
  fg: string;
  bg: string;
  gradient?: Gradient;
  style: ModuleStyle;
  eyeStyle: EyeStyle;
  /** Colour of the three finder patterns; defaults to the foreground/gradient. */
  eyeColor?: string;
  logo?: string;
  /** Logo width as a fraction of the code width. */
  logoSize: number;
}

/** Loosely typed input, as it arrives from the CLI or the interactive prompts. */
export interface RawOptions {
  size?: string | number;
  margin?: string | number;
  ecl?: string;
  fg?: string;
  bg?: string;
  gradient?: string;
  gradientType?: string;
  gradientAngle?: string | number;
  style?: string;
  eyeStyle?: string;
  eyeColor?: string;
  logo?: string;
  logoSize?: string | number;
  raw?: boolean;
}

export const DEFAULTS = {
  size: 1024,
  margin: 4,
  ecl: "M",
  logoEcl: "H",
  fg: "#000000",
  bg: "#ffffff",
  style: "square",
  eyeStyle: "square",
  gradientType: "linear",
  gradientAngle: 45,
  logoSize: 0.22,
} as const;

export interface Resolved {
  options: QrOptions;
  warnings: string[];
}

/**
 * Turn user input into encodable content. Bare hosts like "example.com" get
 * an https:// scheme; anything else must parse as an absolute URL.
 */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("A URL is required");
  // "localhost:3000" and "example.com:8080/x" are hosts with ports, not schemes.
  const hasScheme = /^[a-z][a-z0-9+.-]*:(?!\d+(?:[/?#]|$))/i.test(trimmed);
  const withScheme = hasScheme ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`Not a valid URL: "${input}" (use --raw to encode arbitrary text)`);
  }
  if ((url.protocol === "http:" || url.protocol === "https:") && !url.hostname) {
    throw new Error(`URL has no host: "${input}"`);
  }
  // Keep the user's spelling rather than URL#href, which adds a trailing slash.
  return withScheme;
}

function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  const match = allowed.find((a) => a.toLowerCase() === value.toLowerCase());
  if (!match) throw new Error(`Invalid ${name}: "${value}" (expected one of: ${allowed.join(", ")})`);
  return match;
}

function number(name: string, value: string | number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    throw new Error(`Invalid ${name}: "${value}" (expected a number from ${min} to ${max})`);
  }
  return n;
}

function color(name: string, value: string): string {
  try {
    parseColor(value);
  } catch {
    throw new Error(`Invalid ${name} colour: "${value}"`);
  }
  return value.trim();
}

export function resolveOptions(input: string, raw: RawOptions = {}): Resolved {
  const warnings: string[] = [];
  const data = raw.raw ? input : normalizeUrl(input);
  if (!data) throw new Error("Nothing to encode");

  const fg = color("foreground", raw.fg ?? DEFAULTS.fg);
  const bg = color("background", raw.bg ?? DEFAULTS.bg);

  let gradient: Gradient | undefined;
  if (raw.gradient) {
    const stops = raw.gradient.split(/,(?![^(]*\))/).map((s) => s.trim());
    if (stops.length !== 2 || !stops[0] || !stops[1]) {
      throw new Error(`Invalid gradient: "${raw.gradient}" (expected two colours, e.g. "#ff0080,#7928ca")`);
    }
    gradient = {
      type: oneOf("gradient type", raw.gradientType ?? DEFAULTS.gradientType, GRADIENT_TYPES),
      from: color("gradient start", stops[0]),
      to: color("gradient end", stops[1]),
      angle: number("gradient angle", raw.gradientAngle ?? DEFAULTS.gradientAngle, -360, 360),
    };
  }

  const logo = raw.logo?.trim() || undefined;
  let ecl: ErrorLevel;
  if (raw.ecl) {
    ecl = oneOf("error correction level", raw.ecl, ERROR_LEVELS);
    if (logo && ecl !== "H") {
      warnings.push(`A logo hides part of the code; error correction "${ecl}" may not scan. "H" is recommended.`);
    }
  } else {
    ecl = logo ? DEFAULTS.logoEcl : DEFAULTS.ecl;
  }

  const options: QrOptions = {
    data,
    size: Math.round(number("size", raw.size ?? DEFAULTS.size, 64, 8192)),
    margin: Math.round(number("margin", raw.margin ?? DEFAULTS.margin, 0, 20)),
    ecl,
    fg,
    bg,
    gradient,
    style: oneOf("style", raw.style ?? DEFAULTS.style, MODULE_STYLES),
    eyeStyle: oneOf("eye style", raw.eyeStyle ?? DEFAULTS.eyeStyle, EYE_STYLES),
    eyeColor: raw.eyeColor ? color("eye", raw.eyeColor) : undefined,
    logo,
    logoSize: number("logo size", raw.logoSize ?? DEFAULTS.logoSize, 0.05, 0.3),
  };

  warnings.push(...scanWarnings(options));
  return { options, warnings };
}

/** Heuristics for colour choices that commonly break scanners. */
function scanWarnings(o: QrOptions): string[] {
  const warnings: string[] = [];
  const bg = parseColor(o.bg);
  if (bg.a < 255) {
    warnings.push("Transparent background: make sure whatever the code sits on contrasts with the foreground.");
    if (o.margin < 2) warnings.push("Transparent background with a small margin can be hard to scan.");
    return warnings;
  }
  const darks = [o.gradient?.from ?? o.fg, o.gradient?.to ?? o.fg, o.eyeColor ?? o.fg].map(parseColor);
  const worst = Math.min(...darks.map((c) => contrastRatio(c, bg)));
  if (worst < 3) {
    warnings.push(`Low contrast between foreground and background (${worst.toFixed(1)}:1). Many scanners need at least 3:1.`);
  }
  if (darks.some((c) => luminance(c) > luminance(bg))) {
    warnings.push("Foreground is lighter than the background (inverted). Some older scanners can't read inverted codes.");
  }
  if (o.margin < 2) warnings.push("Margins under 2 modules can stop some scanners finding the code.");
  return warnings;
}
