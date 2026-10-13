import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveOptions } from "../src/options.ts";
import { renderTerminal } from "../src/preview.ts";
import { decodePng } from "./decode.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "qrgen-cli-"));

/** Run the CLI with piped (non-TTY) stdio, so it never goes interactive. */
function qrgen(args: string[], input = "") {
  const r = spawnSync(process.execPath, [CLI, ...args], { input, env: { ...process.env, NO_COLOR: "1" } });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr.toString() };
}

describe("cli", () => {
  it("writes a scannable PNG with styling flags", async () => {
    const out = join(dir, "styled.png");
    const r = qrgen(["example.com", "-o", out, "--style", "rounded", "--eye-style", "circle", "-g", "#be123c,#4c1d95", "-s", "600"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /Saved .*styled\.png .*600×600px/);
    assert.equal(await decodePng(readFileSync(out)), "https://example.com");
  });

  it("reads the URL from stdin and writes PNG to stdout", async () => {
    const r = qrgen(["-o", "-", "-q"], "https://example.org/piped\n");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.equal(await decodePng(r.stdout), "https://example.org/piped");
  });

  it("fails cleanly on bad input without writing a file", () => {
    const out = join(dir, "bad.png");
    const r = qrgen(["not a url", "-o", out]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Not a valid URL/);
    assert.equal(existsSync(out), false);
  });

  it("prints warnings to stderr but still succeeds", () => {
    const r = qrgen(["example.com", "-o", join(dir, "pale.png"), "--fg", "#ddd"]);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /Low contrast/);
  });

  it("refuses interactive mode without a terminal", () => {
    const r = qrgen(["-i"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /needs a terminal/);
  });
});

describe("renderTerminal", () => {
  const { options } = resolveOptions("x.io");

  it("draws two module rows per text line with a quiet zone", () => {
    const lines = renderTerminal(options, { plain: true }).split("\n");
    // Version 1 is 21 modules + 2 quiet modules each side = 25 columns, ceil(25 / 2) = 13 lines.
    assert.equal(lines.length, 13);
    assert.ok(lines.every((l) => [...l].length === 25));
    assert.equal(lines[0], "█".repeat(25), "top quiet zone is all light");
  });

  it("uses the code's colours in truecolor mode", () => {
    const { options: blue } = resolveOptions("x.io", { fg: "#1e3a8a" });
    assert.match(renderTerminal(blue, { trueColor: true }), /\x1b\[38;2;30;58;138m/);
    assert.doesNotMatch(renderTerminal(blue), /38;2;/);
  });
});
