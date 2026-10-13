import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contrastRatio, parseColor } from "../src/color.ts";
import { normalizeUrl, resolveOptions } from "../src/options.ts";

describe("parseColor", () => {
  it("accepts any CSS colour", () => {
    assert.deepEqual(parseColor("#f00"), { r: 255, g: 0, b: 0, a: 255 });
    assert.deepEqual(parseColor("rebeccapurple"), { r: 102, g: 51, b: 153, a: 255 });
    assert.deepEqual(parseColor("rgb(1, 2, 3)"), { r: 1, g: 2, b: 3, a: 255 });
    assert.equal(parseColor("transparent").a, 0);
  });

  it("rejects junk", () => {
    for (const bad of ["", "nope", "#ggg", "#000000"[0]!]) assert.throws(() => parseColor(bad), /Invalid colour/);
  });

  it("computes WCAG contrast", () => {
    assert.equal(contrastRatio(parseColor("black"), parseColor("white")).toFixed(0), "21");
    assert.equal(contrastRatio(parseColor("#777"), parseColor("#777")), 1);
  });
});

describe("normalizeUrl", () => {
  const cases: [string, string][] = [
    ["example.com", "https://example.com"],
    ["  example.com/a?b=c  ", "https://example.com/a?b=c"],
    ["http://example.com", "http://example.com"],
    ["localhost:3000/x", "https://localhost:3000/x"],
    ["example.com:8080", "https://example.com:8080"],
    ["mailto:hi@example.com", "mailto:hi@example.com"],
  ];
  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => assert.equal(normalizeUrl(input), expected));
  }

  it("rejects text that is not a URL", () => {
    assert.throws(() => normalizeUrl("hello world"), /Not a valid URL.*--raw/);
    assert.throws(() => normalizeUrl("   "), /required/);
  });
});

describe("resolveOptions", () => {
  it("applies defaults", () => {
    const { options, warnings } = resolveOptions("example.com");
    assert.equal(options.data, "https://example.com");
    assert.equal(options.size, 1024);
    assert.equal(options.ecl, "M");
    assert.equal(options.style, "square");
    assert.deepEqual(warnings, []);
  });

  it("passes --raw text through untouched", () => {
    assert.equal(resolveOptions("WIFI:S:net;;", { raw: true }).options.data, "WIFI:S:net;;");
  });

  it("parses gradients, including colours with commas", () => {
    const { gradient } = resolveOptions("x.io", { gradient: "rgb(1,2,3), #fff", gradientType: "RADIAL" }).options;
    assert.deepEqual(gradient, { type: "radial", from: "rgb(1,2,3)", to: "#fff", angle: 45 });
    assert.throws(() => resolveOptions("x.io", { gradient: "#fff" }), /two colours/);
  });

  it("defaults to ECL H with a logo, and warns if overridden lower", () => {
    assert.equal(resolveOptions("x.io", { logo: "a.png" }).options.ecl, "H");
    const { options, warnings } = resolveOptions("x.io", { logo: "a.png", ecl: "l" });
    assert.equal(options.ecl, "L");
    assert.match(warnings.join(), /"H" is recommended/);
  });

  it("validates ranges and choices", () => {
    assert.throws(() => resolveOptions("x.io", { size: "10" }), /size/);
    assert.throws(() => resolveOptions("x.io", { logoSize: 0.5 }), /logo size/);
    assert.throws(() => resolveOptions("x.io", { style: "zigzag" }), /expected one of: square, dots, rounded/);
    assert.throws(() => resolveOptions("x.io", { bg: "nope" }), /background colour/);
  });

  it("warns about colours that scan badly", () => {
    assert.match(resolveOptions("x.io", { fg: "#ccc" }).warnings.join(), /Low contrast/);
    assert.match(resolveOptions("x.io", { fg: "white", bg: "black" }).warnings.join(), /inverted/);
    assert.match(resolveOptions("x.io", { bg: "transparent" }).warnings.join(), /Transparent/);
    assert.match(resolveOptions("x.io", { margin: 1 }).warnings.join(), /Margins under 2/);
  });
});
