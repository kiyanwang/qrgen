import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildMatrix } from "../src/matrix.ts";
import { resolveOptions, type RawOptions } from "../src/options.ts";
import { detectImageProtocol, inlineImage, livePreview, renderPixels } from "../src/preview.ts";
import { renderPng } from "../src/render.ts";
import { decodePng } from "./decode.ts";

const opts = (raw: RawOptions = {}) => resolveOptions("example.com/preview", raw).options;
const GHOSTTY = { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", COLORTERM: "truecolor" };
const PLAIN_TRUECOLOR = { TERM: "xterm-256color", COLORTERM: "truecolor" };

/** Reassemble the PNG carried by a Kitty graphics escape sequence. */
function kittyPayload(escapes: string): Buffer {
  const chunks = [...escapes.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
  return Buffer.from(chunks.map((m) => m[2]).join(""), "base64");
}

describe("detectImageProtocol", () => {
  it("recognises terminals with inline images", () => {
    assert.equal(detectImageProtocol(GHOSTTY), "kitty");
    assert.equal(detectImageProtocol({ TERM: "xterm-kitty" }), "kitty");
    assert.equal(detectImageProtocol({ TERM_PROGRAM: "WezTerm" }), "kitty");
    assert.equal(detectImageProtocol({ TERM_PROGRAM: "iTerm.app" }), "iterm");
    assert.equal(detectImageProtocol({ TERM_PROGRAM: "Apple_Terminal" }), undefined);
  });

  it("avoids multiplexers and honours QRGEN_PREVIEW", () => {
    assert.equal(detectImageProtocol({ ...GHOSTTY, TMUX: "/tmp/tmux" }), undefined);
    assert.equal(detectImageProtocol({ ...GHOSTTY, QRGEN_PREVIEW: "text" }), undefined);
    assert.equal(detectImageProtocol({ TERM_PROGRAM: "Apple_Terminal", QRGEN_PREVIEW: "iterm" }), "iterm");
  });
});

describe("inlineImage", () => {
  it("chunks a PNG into Kitty escapes that suppress replies", async () => {
    const png = await renderPng(opts({ size: 900, style: "dots" }));
    const out = inlineImage(png, "kitty", 16);
    const controls = [...out.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
    assert.ok(controls.length > 1, "large image should span several chunks");
    assert.equal(controls[0]![1], "a=T,f=100,q=2,r=16,m=1");
    assert.equal(controls.at(-1)![1], "m=0");
    assert.ok(controls.every((m) => m[2]!.length <= 4096));
    assert.ok(kittyPayload(out).equals(png));
  });

  it("emits the iTerm2 inline file sequence", async () => {
    const png = await renderPng(opts({ size: 200 }));
    const out = inlineImage(png, "iterm", 12);
    assert.ok(out.startsWith(`\x1b]1337;File=inline=1;size=${png.length};height=12;preserveAspectRatio=1:`));
    assert.ok(out.endsWith("\x07\n"));
  });
});

describe("livePreview", () => {
  it("shows the actual rendered image in Ghostty, so shape changes appear", async () => {
    const square = await livePreview(opts(), { fallback: "pixels", env: GHOSTTY, rows: 50 });
    const dots = await livePreview(opts({ style: "dots", eyeStyle: "circle" }), { fallback: "pixels", env: GHOSTTY, rows: 50 });
    assert.notEqual(square, dots);
    // The preview is the real thing: it scans.
    assert.equal(await decodePng(kittyPayload(dots)), "https://example.com/preview");
  });

  it("falls back to sampled pixels that reflect each style", async () => {
    const env = PLAIN_TRUECOLOR;
    const variants = await Promise.all(
      [{}, { style: "dots" }, { style: "rounded" }, { eyeStyle: "circle" }, { eyeStyle: "rounded" }].map((raw) =>
        livePreview(opts(raw), { fallback: "pixels", env, columns: 120 }),
      ),
    );
    assert.equal(new Set(variants).size, variants.length, "every style should look different");
  });

  it("keeps whole modules for the CLI fallback, which must stay scannable", async () => {
    const square = await livePreview(opts(), { fallback: "modules", env: PLAIN_TRUECOLOR });
    const dots = await livePreview(opts({ style: "dots" }), { fallback: "modules", env: PLAIN_TRUECOLOR });
    assert.equal(square, dots);
  });
});

describe("renderPixels", () => {
  it("uses three pixels per module when there is room, fewer when narrow", async () => {
    const lineWidth = (s: string) => [...s.split("\n")[0]!.replace(/\x1b\[[\d;]*m/g, "")].length;
    const total = buildMatrix(opts().data, opts().ecl).size + 4; // preview margin is capped at 2
    assert.equal(lineWidth(await renderPixels(opts(), 200)), total * 3);
    assert.equal(lineWidth(await renderPixels(opts(), total * 2 + 1)), total * 2);
    assert.equal(lineWidth(await renderPixels(opts(), 10)), total);
  });
});
