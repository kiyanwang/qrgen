/**
 * Regenerates the README artwork in docs/ from the real renderer and editor.
 * Run with: npm run docs:art
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage, type SKRSContext2D } from "@napi-rs/canvas";
import { buildMatrix } from "../src/matrix.ts";
import { resolveOptions, type RawOptions } from "../src/options.ts";
import { previewPng } from "../src/preview.ts";
import { renderPng } from "../src/render.ts";
import { App } from "../src/tui/app.ts";
import { designFromRaw } from "../src/tui/design.ts";
import { key } from "../src/tui/input.ts";
import type { Screen } from "../src/tui/screen.ts";
import { theme } from "../src/tui/theme.ts";
import { decodePng } from "../test/decode.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS = join(ROOT, "docs");
const URL_ = "https://kiyanwang.github.io";
const BRAND = ["#ec4899", "#8b5cf6"] as const;
const MONO = "ui-monospace, 'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace";

mkdirSync(join(DOCS, "headings"), { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), "qrgen-art-"));

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const write = (name: string, data: string | Buffer) => {
  writeFileSync(join(DOCS, name), data);
  console.log(`  docs/${name}  ${(Buffer.byteLength(data) / 1024).toFixed(0)} kB`);
};
const gradientDef = (id: string, x2 = "100%", y2 = "0%") =>
  `<linearGradient id="${id}" x1="0%" y1="0%" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${BRAND[0]}"/><stop offset="1" stop-color="${BRAND[1]}"/></linearGradient>`;

/** QR modules as SVG rects, merging horizontal runs. */
function qrRects(data: string, x: number, y: number, unit: number): string {
  const m = buildMatrix(data, "M");
  let out = "";
  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      if (!m.isDark(r, c)) continue;
      let run = 1;
      while (m.isDark(r, c + run)) run++;
      out += `<rect x="${x + c * unit}" y="${y + r * unit}" width="${run * unit}" height="${unit}"/>`;
      c += run - 1;
    }
  }
  return out;
}

// ---- wordmark ---------------------------------------------------------------

function wordmark() {
  const unit = 3.6;
  const size = 25 * unit;
  write(
    "wordmark.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 170" width="760" height="170" font-family="${MONO}">
  <defs>${gradientDef("brand")}${gradientDef("mark", "100%", "100%")}</defs>
  <g fill="url(#mark)">${qrRects(URL_, 190, 30, unit)}</g>
  <text x="${190 + size + 28}" y="${30 + size / 2 + 24}" font-size="68" font-weight="700" fill="url(#brand)" letter-spacing="-1"><tspan opacity="0.55">$ </tspan>qrgen</text>
  <rect x="190" y="${30 + size + 17}" width="380" height="1.5" fill="url(#brand)"/>
  <text x="380" y="${30 + size + 40}" font-size="11" font-weight="500" fill="${BRAND[1]}" text-anchor="middle" letter-spacing="6" word-spacing="14">QR CODES FROM THE TERMINAL</text>
</svg>
`,
  );
}

// ---- section headings -------------------------------------------------------

const ICONS: Record<string, string> = {
  // A terminal prompt.
  cli: `<rect x="1" y="3" width="26" height="22" rx="4" fill="none" stroke="url(#h)" stroke-width="2.5"/><path d="M7 11 L12 15 L7 19" fill="none" stroke="url(#h)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="15" y1="19" x2="21" y2="19" stroke="url(#h)" stroke-width="2.5" stroke-linecap="round"/>`,
  // A window with a sidebar.
  editor: `<rect x="1" y="3" width="26" height="22" rx="4" fill="none" stroke="url(#h)" stroke-width="2.5"/><line x1="1" y1="9" x2="27" y2="9" stroke="url(#h)" stroke-width="2.5"/><line x1="10" y1="9" x2="10" y2="25" stroke="url(#h)" stroke-width="2.5"/><rect x="14" y="13" width="9" height="8" rx="1.5" fill="url(#h)"/>`,
  // A colour wheel.
  colour: ["#ef4444", "#f59e0b", "#22c55e", "#06b6d4", "#3b82f6", "#a855f7"]
    .map((c, i) => {
      const a0 = (i / 6) * Math.PI * 2 - Math.PI / 2;
      const a1 = ((i + 1) / 6) * Math.PI * 2 - Math.PI / 2;
      const p = (a: number, r: number) => `${(14 + r * Math.cos(a)).toFixed(2)} ${(14 + r * Math.sin(a)).toFixed(2)}`;
      return `<path d="M${p(a0, 13)} A13 13 0 0 1 ${p(a1, 13)} L${p(a1, 5)} A5 5 0 0 0 ${p(a0, 5)} Z" fill="${c}"/>`;
    })
    .join(""),
  // Square, dot, rounded, eye.
  styles: `<rect x="1" y="1" width="11" height="11" fill="url(#h)"/><circle cx="21.5" cy="6.5" r="5.5" fill="url(#h)"/><rect x="1" y="16" width="11" height="11" rx="4" fill="url(#h)"/><rect x="16" y="16" width="11" height="11" rx="3" fill="none" stroke="url(#h)" stroke-width="2.5"/><rect x="19.5" y="19.5" width="4" height="4" fill="url(#h)"/>`,
};

function heading(name: string, title: string, label: string) {
  write(
    `headings/${name}.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 52" width="600" height="52" font-family="${MONO}">
  <defs><linearGradient id="h" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="28" y2="28"><stop offset="0" stop-color="${BRAND[0]}"/><stop offset="1" stop-color="${BRAND[1]}"/></linearGradient>${gradientDef("t")}</defs>
  <g transform="translate(8, 12)">${ICONS[name]}</g>
  <text x="46" y="34" font-size="24" font-weight="700" fill="url(#t)">${esc(title)}</text>
  <text x="592" y="34" font-size="10" font-weight="500" fill="${BRAND[1]}" opacity="0.8" text-anchor="end" letter-spacing="3">${esc(label.toUpperCase())}</text>
</svg>
`,
  );
}

// ---- terminal screenshots ---------------------------------------------------

const CW = 16;
const CH = 34;
const BAR = 52;

function windowChrome(ctx: SKRSContext2D, w: number, h: number, title: string, bg: string) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 20);
  ctx.clip();
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#0b0c0f";
  ctx.fillRect(0, 0, w, BAR);
  ["#ff5f57", "#febc2e", "#28c840"].forEach((c, i) => {
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(30 + i * 34, BAR / 2, 11, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = "#6b7280";
  ctx.font = `24px Menlo`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(title, w / 2, BAR / 2 + 1);
  ctx.restore();
}

/** Draw a screen buffer like a terminal would, with box-drawing glyphs as real lines. */
function drawCells(ctx: SKRSContext2D, s: Screen, oy: number) {
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let y = 0; y < s.height; y++) {
    for (let x = 0; x < s.width; x++) {
      const c = s.cell(x, y)!;
      const px = x * CW;
      const py = oy + y * CH;
      ctx.fillStyle = c.bg ?? theme.bg;
      ctx.fillRect(px, py, CW + 0.5, CH + 0.5);
      const fg = c.fg ?? theme.text;
      ctx.fillStyle = fg;
      ctx.strokeStyle = fg;
      ctx.lineWidth = 2;
      const mx = px + CW / 2;
      const my = py + CH / 2;
      const r = CW / 2;
      const line = (x1: number, y1: number, x2: number, y2: number) => {
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      };
      switch (c.ch) {
        case " ":
          break;
        case "─":
          line(px, my, px + CW, my);
          break;
        case "│":
          line(mx, py, mx, py + CH);
          break;
        case "╭":
        case "╮":
        case "╰":
        case "╯": {
          const right = c.ch === "╭" || c.ch === "╰";
          const down = c.ch === "╭" || c.ch === "╮";
          ctx.beginPath();
          ctx.moveTo(right ? px + CW : px, my);
          ctx.arcTo(mx, my, mx, down ? my + r : my - r, r);
          ctx.lineTo(mx, down ? py + CH : py);
          ctx.stroke();
          break;
        }
        case "▀":
          ctx.fillRect(px, py, CW + 0.5, CH / 2);
          break;
        case "▄":
          ctx.fillRect(px, py + CH / 2, CW + 0.5, CH / 2);
          break;
        case "█":
          ctx.fillRect(px, py, CW + 0.5, CH + 0.5);
          break;
        case "▎":
          ctx.fillRect(px + 2, py + 4, CW / 4, CH - 8);
          break;
        case "▐":
          ctx.fillRect(px + CW / 2, py, CW / 2, CH);
          break;
        case "▌":
          ctx.fillRect(px, py, CW / 2, CH);
          break;
        default:
          ctx.font = `${c.attrs & 1 ? "bold " : ""}26px Menlo`;
          ctx.globalAlpha = c.attrs & 2 ? 0.6 : 1;
          ctx.fillText(c.ch, mx, my + 1);
          ctx.globalAlpha = 1;
      }
    }
  }
}

async function screenshot(name: string, cols: number, rows: number, setup: (app: App) => Promise<void> | void) {
  const writes: string[] = [];
  const app = new App(
    {
      columns: cols,
      rows,
      write: (s) => void writes.push(s),
      env: { TERM_PROGRAM: "ghostty", COLORTERM: "truecolor" },
      cwd: ROOT,
      exit: () => {},
    },
    designFromRaw("kiyanwang.github.io", { style: "rounded", eyeStyle: "rounded", gradient: "#ff0080,#7928ca" }).design,
    "qrcode.png",
  );
  app.handle({ type: "cellsize", width: CW, height: CH });
  app.start();
  await app.settle();
  await setup(app);
  await app.settle();
  app.render();

  const w = cols * CW;
  const h = rows * CH + BAR;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  windowChrome(ctx, w, h, `~/projects — qrgen -i kiyanwang.github.io`, theme.bg);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(0, 0, w, h, 20);
  ctx.clip();
  drawCells(ctx, app.screen!, BAR);

  // Composite the inline image where the editor placed it, as Ghostty would.
  const placements = [...writes.join("").matchAll(/\x1b\[(\d+);(\d+)H\x1b_Ga=p,[^\x1b]*c=(\d+),r=(\d+)/g)];
  const last = placements.at(-1);
  const png = (app as unknown as { preview: { png?: Buffer } }).preview.png;
  if (last && png) {
    const [, row, col, c, r] = last.map(Number);
    ctx.drawImage(await loadImage(png), (col! - 1) * CW, BAR + (row! - 1) * CH, c! * CW, r! * CH);
  }
  ctx.restore();
  write(`${name}.png`, canvas.toBuffer("image/png"));
}

// ---- style gallery ----------------------------------------------------------

async function makeLogo(): Promise<string> {
  const c = createCanvas(256, 256);
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, 256, 256);
  g.addColorStop(0, "#ec4899");
  g.addColorStop(1, "#8b5cf6");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.roundRect(0, 0, 256, 256, 64);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 150px Menlo";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("qr", 128, 136);
  const path = join(scratch, "logo.png");
  writeFileSync(path, c.toBuffer("image/png"));
  return path;
}

async function gallery() {
  const logo = await makeLogo();
  const tiles: { title: string; flags: string; raw: RawOptions }[] = [
    { title: "Classic", flags: "(defaults)", raw: {} },
    { title: "Dots", flags: `--style dots --eye-style circle --fg "#1d4ed8"`, raw: { style: "dots", eyeStyle: "circle", fg: "#1d4ed8" } },
    {
      title: "Gradient",
      flags: `--style rounded --eye-style rounded -g "#ff0080,#7928ca"`,
      raw: { style: "rounded", eyeStyle: "rounded", gradient: "#ff0080,#7928ca" },
    },
    {
      title: "Radial",
      flags: `-g "#0ea5e9,#1e1b4b" --gradient-type radial --bg "#fefce8"`,
      raw: { gradient: "#0ea5e9,#1e1b4b", gradientType: "radial", bg: "#fefce8" },
    },
    {
      title: "Logo",
      flags: `--logo logo.png --style rounded --eye-style rounded`,
      raw: { logo, style: "rounded", eyeStyle: "rounded" },
    },
    {
      title: "Eye colour",
      flags: `--style dots --eye-style rounded --eye-color "#e11d48"`,
      raw: { style: "dots", eyeStyle: "rounded", eyeColor: "#e11d48" },
    },
    {
      title: "Transparent",
      flags: `--bg transparent --fg "#0f766e" --eye-style circle`,
      raw: { bg: "transparent", fg: "#0f766e", eyeStyle: "circle" },
    },
    {
      title: "Sunset",
      flags: `-g "#f97316,#db2777" --style dots --eye-style rounded`,
      raw: { gradient: "#f97316,#db2777", style: "dots", eyeStyle: "rounded" },
    },
  ];

  const Q = 300;
  const PAD = 22;
  const CAP = 112;
  const GAP = 22;
  const COLS = 4;
  const cardW = Q + PAD * 2;
  const cardH = Q + PAD * 2 + CAP;
  const W = COLS * cardW + (COLS + 1) * GAP;
  const H = Math.ceil(tiles.length / COLS) * cardH + (Math.ceil(tiles.length / COLS) + 1) * GAP;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = theme.bg;
  ctx.beginPath();
  ctx.roundRect(0, 0, W, H, 24);
  ctx.fill();

  for (const [i, t] of tiles.entries()) {
    const { options } = resolveOptions(URL_, { ...t.raw, size: 900, margin: 3 });
    const png = await renderPng(options);
    const decoded = await decodePng(png);
    if (decoded !== URL_) throw new Error(`Gallery tile "${t.title}" does not scan (got ${decoded})`);

    const x = GAP + (i % COLS) * (cardW + GAP);
    const y = GAP + Math.floor(i / COLS) * (cardH + GAP);
    ctx.fillStyle = theme.panel;
    ctx.beginPath();
    ctx.roundRect(x, y, cardW, cardH, 16);
    ctx.fill();
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x + PAD, y + PAD, Q, Q, 10);
    ctx.clip();
    ctx.drawImage(await loadImage(await previewPng(options, Q * 2)), x + PAD, y + PAD, Q, Q);
    ctx.restore();

    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = theme.text;
    ctx.font = "bold 24px Menlo";
    ctx.fillText(t.title, x + PAD, y + PAD + Q + 40);
    ctx.font = "16px Menlo";
    ctx.fillStyle = theme.accent;
    // Wrap the flags to the card width.
    const words = t.flags.split(" ");
    let line = "";
    let ly = y + PAD + Q + 66;
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (ctx.measureText(next).width > Q && line) {
        ctx.fillText(line, x + PAD, ly);
        ly += 22;
        line = word;
      } else line = next;
    }
    ctx.fillText(line, x + PAD, ly);
  }
  write("gallery.png", canvas.toBuffer("image/png"));
}

// ---- CLI transcript ---------------------------------------------------------

function cliTranscript() {
  const out = join(scratch, "qrcode.png");
  const run = (args: string[], input?: string) => {
    const r = spawnSync(process.execPath, [join(ROOT, "src/cli.ts"), ...args], {
      input,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return r.stderr.toString().replaceAll(scratch + "/", "").trim().split("\n").filter(Boolean);
  };
  const sessions: { cmd: string; lines: string[] }[] = [
    {
      cmd: `qrgen kiyanwang.github.io --style dots --eye-style circle -g "#ff0080,#7928ca"`,
      lines: run(["kiyanwang.github.io", "--style", "dots", "--eye-style", "circle", "-g", "#ff0080,#7928ca", "-o", out]),
    },
    {
      cmd: `qrgen example.com --fg "#cbd5e1" -o pale.png`,
      lines: run(["example.com", "--fg", "#cbd5e1", "-o", join(scratch, "pale.png")]),
    },
    { cmd: `qrgen "not a url"`, lines: run(["not a url", "-o", out]) },
  ];

  const lh = 22;
  const rows = sessions.reduce((n, s) => n + 1 + s.lines.length + 1, 0);
  const W = 860;
  const H = 40 + rows * lh + 12;
  const color = (l: string) => (l.startsWith("✔") ? "#9ece6a" : l.startsWith("⚠") ? "#e0af68" : l.startsWith("✖") ? "#f7768e" : "#a9b1d6");
  let y = 40 + lh - 4;
  let body = "";
  for (const s of sessions) {
    body += `<text x="20" y="${y}"><tspan fill="#bb9af7">$</tspan> <tspan fill="#c0caf5">${esc(s.cmd)}</tspan></text>\n`;
    y += lh;
    for (const l of s.lines) {
      const shown = l.length > 100 ? `${l.slice(0, 99)}…` : l;
      body += `<text x="20" y="${y}" fill="${color(l)}">${esc(shown)}</text>\n`;
      y += lh;
    }
    y += lh;
  }
  write(
    "cli.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" rx="10" fill="#1a1b26"/>
  <rect width="${W}" height="28" rx="10" fill="#16161e"/><rect y="18" width="${W}" height="10" fill="#16161e"/>
  <circle cx="18" cy="14" r="5.5" fill="#f7768e"/><circle cx="36" cy="14" r="5.5" fill="#e0af68"/><circle cx="54" cy="14" r="5.5" fill="#9ece6a"/>
  <text x="${W / 2}" y="18" font-family="${MONO}" font-size="11" fill="#565f89" text-anchor="middle">~/projects — zsh</text>
  <g font-family="${MONO}" font-size="13" xml:space="preserve">
${body}  </g>
</svg>
`,
  );
}

// ---- run --------------------------------------------------------------------

console.log("Generating README art…");
wordmark();
heading("cli", "qrgen", "Command line");
heading("editor", "qrgen -i", "Full-screen editor");
heading("colour", "Colours", "Wheel · sliders · palette");
heading("styles", "Styles", "Shapes · gradients · logos");
cliTranscript();
await gallery();
await screenshot("editor", 108, 30, (app) => {
  // Select "Modules" so the inline ‹ › arrows show.
  for (let i = 0; i < 6; i++) app.handle(key("down"));
});
await screenshot("picker", 108, 30, (app) => {
  app.handle(key("down"));
  app.handle(key("enter"));
  for (let i = 0; i < 3; i++) app.handle(key("down", { shift: true }));
});
console.log("Done.");
