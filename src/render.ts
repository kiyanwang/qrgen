import { createCanvas, loadImage, Path2D, type Canvas, type CanvasGradient, type SKRSContext2D } from "@napi-rs/canvas";
import { buildMatrix, finderOrigins, isAlignment, isFinder, type Matrix } from "./matrix.ts";
import type { EyeStyle, Gradient, ModuleStyle, QrOptions } from "./options.ts";

/** Module-index rectangle (inclusive) left blank for the logo. */
interface Hole {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

interface Layout {
  /** Pixels per module. */
  unit: number;
  /** Pixel offset of module (0, 0). */
  origin: number;
  /** Pixel width of the code itself, excluding the quiet zone. */
  codeWidth: number;
}

export async function renderPng(options: QrOptions): Promise<Buffer> {
  return (await renderCanvas(options)).encode("png");
}

export async function renderCanvas(options: QrOptions): Promise<Canvas> {
  const matrix = buildMatrix(options.data, options.ecl);
  const { size } = options;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");

  const unit = size / (matrix.size + options.margin * 2);
  const layout: Layout = { unit, origin: options.margin * unit, codeWidth: matrix.size * unit };

  ctx.fillStyle = options.bg;
  ctx.fillRect(0, 0, size, size);

  const logo = options.logo ? await loadLogo(options.logo) : undefined;
  const hole = logo ? logoHole(matrix, layout, options.logoSize, logo.width / logo.height) : undefined;

  const ink = paint(ctx, options.fg, options.gradient, size, layout);
  // Scanners locate alignment patterns by their solid ring, which separate
  // dots break up, so in dots mode draw them as small solid eyes instead.
  const solidAlignment = options.style === "dots";
  ctx.fillStyle = ink;
  ctx.fill(modulesPath(matrix, layout, options.style, hole, solidAlignment));
  if (solidAlignment) {
    for (const [row, col] of matrix.alignmentCenters) {
      drawEye(ctx, layout.origin + (col - 2) * unit, layout.origin + (row - 2) * unit, unit, 5, options.eyeStyle);
    }
  }

  ctx.fillStyle = options.eyeColor ?? ink;
  for (const [row, col] of finderOrigins(matrix.size)) {
    drawEye(ctx, layout.origin + col * unit, layout.origin + row * unit, unit, 7, options.eyeStyle);
  }

  if (logo && hole) drawLogo(ctx, logo, layout, hole);

  return canvas;
}

async function loadLogo(file: string) {
  try {
    return await loadImage(file);
  } catch (err) {
    throw new Error(`Could not load logo "${file}": ${(err as Error).message}`);
  }
}

function paint(
  ctx: SKRSContext2D,
  fg: string,
  gradient: Gradient | undefined,
  size: number,
  { codeWidth }: Layout,
): string | CanvasGradient {
  if (!gradient) return fg;
  const c = size / 2;
  let g: CanvasGradient;
  if (gradient.type === "radial") {
    g = ctx.createRadialGradient(c, c, 0, c, c, (codeWidth / 2) * Math.SQRT2);
  } else {
    const rad = (gradient.angle * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    // Half the extent of the code square projected onto the gradient direction.
    const half = (codeWidth / 2) * (Math.abs(dx) + Math.abs(dy));
    g = ctx.createLinearGradient(c - dx * half, c - dy * half, c + dx * half, c + dy * half);
  }
  g.addColorStop(0, gradient.from);
  g.addColorStop(1, gradient.to);
  return g;
}

/** One path for every data module, so a single fill avoids seams between neighbours. */
function modulesPath(
  m: Matrix,
  { unit, origin }: Layout,
  style: ModuleStyle,
  hole: Hole | undefined,
  skipAlignment: boolean,
): Path2D {
  const path = new Path2D();
  const inHole = (r: number, c: number) =>
    hole !== undefined && r >= hole.top && r <= hole.bottom && c >= hole.left && c <= hole.right;

  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (!m.isDark(r, c) || isFinder(r, c, m.size) || inHole(r, c)) continue;
      if (skipAlignment && isAlignment(r, c, m.alignmentCenters)) continue;
      const x = origin + c * unit;
      const y = origin + r * unit;
      if (style === "dots") {
        path.moveTo(x + unit, y + unit / 2);
        path.arc(x + unit / 2, y + unit / 2, unit * 0.45, 0, Math.PI * 2);
      } else if (style === "rounded") {
        // Round a corner only where both of its edge neighbours are empty,
        // so runs of modules merge into smooth blobs.
        const dark = (dr: number, dc: number) => m.isDark(r + dr, c + dc) && !inHole(r + dr, c + dc);
        const up = dark(-1, 0);
        const down = dark(1, 0);
        const left = dark(0, -1);
        const right = dark(0, 1);
        const rad = unit / 2;
        roundedRect(path, x, y, unit, unit, [
          up || left ? 0 : rad,
          up || right ? 0 : rad,
          down || right ? 0 : rad,
          down || left ? 0 : rad,
        ]);
      } else {
        // Snap to whole pixels so adjacent squares tile exactly.
        const x0 = Math.round(x);
        const y0 = Math.round(y);
        path.rect(x0, y0, Math.round(x + unit) - x0, Math.round(y + unit) - y0);
      }
    }
  }
  return path;
}

/** Clockwise rectangle with per-corner radii [topLeft, topRight, bottomRight, bottomLeft]. */
function roundedRect(p: Path2D, x: number, y: number, w: number, h: number, [tl, tr, br, bl]: number[]) {
  p.moveTo(x + tl!, y);
  p.lineTo(x + w - tr!, y);
  if (tr) p.arcTo(x + w, y, x + w, y + tr, tr);
  p.lineTo(x + w, y + h - br!);
  if (br) p.arcTo(x + w, y + h, x + w - br, y + h, br);
  p.lineTo(x + bl!, y + h);
  if (bl) p.arcTo(x, y + h, x, y + h - bl, bl);
  p.lineTo(x, y + tl!);
  if (tl) p.arcTo(x, y, x + tl, y, tl);
  p.closePath();
}

/**
 * A finder (n = 7) or alignment (n = 5) pattern: a one-module ring around a
 * gap, around a solid centre of n − 4 modules.
 */
function drawEye(ctx: SKRSContext2D, x: number, y: number, unit: number, n: number, style: EyeStyle) {
  const outer = n * unit;
  const inner = (n - 2) * unit;
  const ball = (n - 4) * unit;
  const c = outer / 2;
  const frame = new Path2D();
  const centre = new Path2D();
  if (style === "circle") {
    frame.arc(x + c, y + c, outer / 2, 0, Math.PI * 2);
    frame.moveTo(x + c + inner / 2, y + c);
    frame.arc(x + c, y + c, inner / 2, 0, Math.PI * 2);
    centre.arc(x + c, y + c, ball / 2, 0, Math.PI * 2);
  } else {
    // Radii proportional to each part, so 5×5 alignment patterns match the 7×7 eyes.
    const k = style === "rounded" ? 1 : 0;
    const r = 0.28 * outer * k;
    const ri = 0.25 * inner * k;
    const rb = 0.3 * ball * k;
    roundedRect(frame, x, y, outer, outer, [r, r, r, r]);
    roundedRect(frame, x + unit, y + unit, inner, inner, [ri, ri, ri, ri]);
    roundedRect(centre, x + 2 * unit, y + 2 * unit, ball, ball, [rb, rb, rb, rb]);
  }
  ctx.fill(frame, "evenodd");
  ctx.fill(centre);
}

/**
 * Pick the block of modules to clear for the logo: centred, sized from the
 * logo's aspect ratio, plus a one-module padding ring.
 */
function logoHole(m: Matrix, { codeWidth, unit }: Layout, fraction: number, aspect: number): Hole {
  const maxModules = (codeWidth * fraction) / unit;
  const w = aspect >= 1 ? maxModules : maxModules * aspect;
  const h = aspect >= 1 ? maxModules / aspect : maxModules;
  // Keep the hole symmetric about the centre module by matching parity with the grid.
  const fit = (n: number) => {
    let k = Math.ceil(n) + 2;
    if (k % 2 !== m.size % 2) k++;
    return Math.min(k, m.size - 16);
  };
  const cols = fit(w);
  const rows = fit(h);
  const left = (m.size - cols) / 2;
  const top = (m.size - rows) / 2;
  return { top, left, bottom: top + rows - 1, right: left + cols - 1 };
}

function drawLogo(ctx: SKRSContext2D, img: Awaited<ReturnType<typeof loadImage>>, { unit, origin }: Layout, hole: Hole) {
  // Fit inside the hole, leaving the one-module padding ring clear.
  const boxW = (hole.right - hole.left - 1) * unit;
  const boxH = (hole.bottom - hole.top - 1) * unit;
  const scale = Math.min(boxW / img.width, boxH / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  const cx = origin + ((hole.left + hole.right + 1) / 2) * unit;
  const cy = origin + ((hole.top + hole.bottom + 1) / 2) * unit;
  ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
}
