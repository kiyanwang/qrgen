import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOptions, type RawOptions } from "../src/options.ts";
import { renderPng } from "../src/render.ts";
import { decodePng, keepSample } from "./decode.ts";

const URL_IN = "example.com/some/path?q=1";
const URL_OUT = "https://example.com/some/path?q=1";

async function roundTrip(name: string, raw: RawOptions, input = URL_IN) {
  const { options } = resolveOptions(input, raw);
  const png = await renderPng(options);
  keepSample(name, png);
  return { png, decoded: await decodePng(png) };
}

describe("renderPng", () => {
  let logoPath: string;

  before(() => {
    // A simple solid logo; deliberately wider than tall to exercise aspect handling.
    const c = createCanvas(300, 200);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#e11d48";
    ctx.fillRect(0, 0, 300, 200);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 120px sans-serif";
    ctx.fillText("Q", 110, 150);
    logoPath = join(mkdtempSync(join(tmpdir(), "qrgen-")), "logo.png");
    writeFileSync(logoPath, c.toBuffer("image/png"));
  });

  it("produces a PNG of the requested size", async () => {
    const { png } = await roundTrip("size", { size: 300 });
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16), 300);
    assert.equal(png.readUInt32BE(20), 300);
  });

  const scannable: [string, RawOptions][] = [
    ["default", {}],
    ["dots-circle", { style: "dots", eyeStyle: "circle", fg: "#1e3a8a" }],
    ["rounded", { style: "rounded", eyeStyle: "rounded", fg: "rebeccapurple", bg: "#fdf4ff" }],
    ["linear-gradient", { style: "rounded", eyeStyle: "rounded", gradient: "#ff0080,#7928ca", eyeColor: "#111" }],
    ["radial-gradient", { gradient: "rgb(14,165,233), #1e1b4b", gradientType: "radial", bg: "#fefce8" }],
    ["transparent", { bg: "transparent", fg: "#0f172a" }],
    ["small", { size: 128, margin: 2 }],
    ["ecl-l", { ecl: "L" }],
  ];
  for (const [name, raw] of scannable) {
    it(`decodes: ${name}`, async () => {
      assert.equal((await roundTrip(name, raw)).decoded, URL_OUT);
    });
  }

  it("decodes with a logo (forces ECL H)", async () => {
    const { decoded } = await roundTrip("logo", { logo: logoPath, style: "rounded", eyeStyle: "rounded" });
    assert.equal(decoded, URL_OUT);
  });

  it("decodes a long URL with a max-size logo", async () => {
    const long = `https://example.com/${"segment/".repeat(20)}?utm_source=qrgen&utm_medium=print`;
    const { decoded } = await roundTrip("logo-long", { logo: logoPath, logoSize: 0.3, size: 1200 }, long);
    assert.equal(decoded, long);
  });

  it("reports a missing logo clearly", async () => {
    const { options } = resolveOptions(URL_IN, { logo: "/nope/missing.png" });
    await assert.rejects(renderPng(options), /Could not load logo "\/nope\/missing.png"/);
  });
});
