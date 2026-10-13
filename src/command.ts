import { DEFAULTS, type RawOptions } from "./options.ts";

/** The equivalent non-interactive command, so a design can be scripted. */
export function commandLine(url: string, raw: RawOptions, output: string): string {
  const q = (v: string) => (/^[\w./:@%+=,-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`);
  const parts = ["qrgen", q(url), "-o", q(output)];
  const flag = (name: string, value: unknown, fallback?: unknown) => {
    if (value === undefined || value === "" || String(value) === String(fallback)) return;
    parts.push(`--${name}`, q(String(value)));
  };
  flag("size", raw.size, DEFAULTS.size);
  flag("margin", raw.margin, DEFAULTS.margin);
  flag("ecl", raw.ecl);
  if (raw.gradient) {
    flag("gradient", raw.gradient);
    flag("gradient-type", raw.gradientType, DEFAULTS.gradientType);
    if (raw.gradientType !== "radial") flag("gradient-angle", raw.gradientAngle, DEFAULTS.gradientAngle);
  } else {
    flag("fg", raw.fg, DEFAULTS.fg);
  }
  flag("bg", raw.bg, DEFAULTS.bg);
  flag("style", raw.style, DEFAULTS.style);
  flag("eye-style", raw.eyeStyle, DEFAULTS.eyeStyle);
  flag("eye-color", raw.eyeColor);
  flag("logo", raw.logo);
  if (raw.logo) flag("logo-size", raw.logoSize, DEFAULTS.logoSize);
  if (raw.raw) parts.push("--raw");
  return parts.join(" ");
}
