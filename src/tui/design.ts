import {
  DEFAULTS,
  resolveOptions,
  type ErrorLevel,
  type EyeStyle,
  type ModuleStyle,
  type RawOptions,
} from "../options.ts";

export const FILLS = ["solid", "linear", "radial"] as const;
export type Fill = (typeof FILLS)[number];

/** What the editor manipulates: like RawOptions, but keeps gradient colours while the fill is solid. */
export interface Design {
  url: string;
  raw: boolean;
  fill: Fill;
  fg: string;
  /** Gradient end colour. */
  fg2: string;
  angle: number;
  bg: string;
  eyeColor?: string;
  style: ModuleStyle;
  eyeStyle: EyeStyle;
  logo?: string;
  logoSize: number;
  size: number;
  margin: number;
  /** undefined = automatic (M, or H with a logo). */
  ecl?: ErrorLevel;
}

export function defaultDesign(url = ""): Design {
  return {
    url,
    raw: false,
    fill: "solid",
    fg: DEFAULTS.fg,
    fg2: "#7928ca",
    angle: DEFAULTS.gradientAngle,
    bg: DEFAULTS.bg,
    style: DEFAULTS.style,
    eyeStyle: DEFAULTS.eyeStyle,
    logoSize: DEFAULTS.logoSize,
    size: DEFAULTS.size,
    margin: DEFAULTS.margin,
  };
}

/** Start from command-line options. Returns an error message if some were invalid (defaults are used instead). */
export function designFromRaw(url: string | undefined, raw: RawOptions): { design: Design; error?: string } {
  const design = defaultDesign(url ?? "");
  design.raw = Boolean(raw.raw);
  try {
    // Validate everything except the URL, which the user can fix in the editor.
    const { options: o } = resolveOptions("placeholder", { ...raw, raw: true });
    Object.assign(design, {
      fg: o.gradient?.from ?? o.fg,
      fg2: o.gradient?.to ?? design.fg2,
      fill: o.gradient?.type ?? "solid",
      angle: o.gradient?.angle ?? design.angle,
      bg: o.bg,
      eyeColor: o.eyeColor,
      style: o.style,
      eyeStyle: o.eyeStyle,
      logo: o.logo,
      logoSize: o.logoSize,
      size: o.size,
      margin: o.margin,
      ecl: raw.ecl ? o.ecl : undefined,
    });
    return { design };
  } catch (err) {
    return { design, error: `${(err as Error).message} — using defaults` };
  }
}

export function designToRaw(d: Design): RawOptions {
  const gradient = d.fill !== "solid";
  return {
    raw: d.raw,
    fg: gradient ? undefined : d.fg,
    gradient: gradient ? `${d.fg},${d.fg2}` : undefined,
    gradientType: gradient ? d.fill : undefined,
    gradientAngle: d.fill === "linear" ? d.angle : undefined,
    bg: d.bg,
    eyeColor: d.eyeColor,
    style: d.style,
    eyeStyle: d.eyeStyle,
    logo: d.logo,
    logoSize: d.logo ? d.logoSize : undefined,
    size: d.size,
    margin: d.margin,
    ecl: d.ecl,
  };
}
