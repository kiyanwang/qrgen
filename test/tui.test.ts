import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { App } from "../src/tui/app.ts";
import { hsvToRgb, rgbToHsv, toHex } from "../src/tui/colorspace.ts";
import { designFromRaw, designToRaw } from "../src/tui/design.ts";
import { InputParser, key, type InputEvent, type MouseEvent } from "../src/tui/input.ts";
import { diff, Screen } from "../src/tui/screen.ts";
import { ColorPicker } from "../src/tui/widgets/color-picker.ts";
import { FilePicker } from "../src/tui/widgets/file-picker.ts";
import { decodePng } from "./decode.ts";
import { keepScreen } from "./snapshot.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "qrgen-tui-"));
const mouse = (x: number, y: number, action: MouseEvent["action"] = "down"): MouseEvent => ({
  type: "mouse",
  x,
  y,
  button: action === "up" || action.startsWith("wheel") ? "none" : "left",
  action,
  shift: false,
});

function makeApp(opts: { url?: string; raw?: Parameters<typeof designFromRaw>[1]; env?: NodeJS.ProcessEnv; cwd?: string } = {}) {
  const writes: string[] = [];
  let exited = false;
  const host = {
    columns: 130,
    rows: 40,
    write: (s: string) => void writes.push(s),
    env: opts.env ?? { COLORTERM: "truecolor" },
    cwd: opts.cwd ?? tmp(),
    exit: () => void (exited = true),
  };
  const app = new App(host, designFromRaw(opts.url ?? "example.com/tui", opts.raw ?? {}).design, "qrcode.png");
  app.start();
  const send = (...events: (InputEvent | string)[]) => {
    for (const e of events) app.handle(typeof e === "string" ? key(e) : e);
  };
  const type = (text: string) => [...text].forEach((ch) => app.handle(key("char", { ch })));
  const text = () => app.screen!.toString();
  return { app, host, writes, send, type, text, exited: () => exited };
}

describe("InputParser", () => {
  const p = () => new InputParser();

  it("parses keys, modifiers and UTF-8", () => {
    const ev = p().feed("a\x1b[A\x1b[1;2C\r\t\x7f\x13é\x1b[Z\x1b[3~");
    assert.deepEqual(
      ev.map((e) => (e.type === "key" ? `${e.ctrl ? "^" : ""}${e.shift ? "S-" : ""}${e.name === "char" ? e.ch : e.name}` : e.type)),
      ["a", "up", "S-right", "enter", "tab", "backspace", "^s", "é", "S-tab", "delete"],
    );
  });

  it("waits on a lone ESC until flushed", () => {
    const parser = p();
    assert.deepEqual(parser.feed("\x1b"), []);
    assert.ok(parser.pending);
    assert.deepEqual(parser.flush(), [key("escape")]);
    // ...but a sequence split across reads still parses.
    assert.deepEqual(parser.feed("\x1b["), []);
    assert.deepEqual(parser.feed("B"), [key("down")]);
  });

  it("parses SGR mouse, paste and cell-size replies", () => {
    const ev = p().feed("\x1b[<0;10;5M\x1b[<32;11;5M\x1b[<0;11;5m\x1b[<64;1;1M\x1b[200~hello\nworld\x1b[201~\x1b[6;20;10t");
    assert.deepEqual(ev, [
      { type: "mouse", x: 9, y: 4, button: "left", action: "down", shift: false },
      { type: "mouse", x: 10, y: 4, button: "left", action: "drag", shift: false },
      { type: "mouse", x: 10, y: 4, button: "left", action: "up", shift: false },
      { type: "mouse", x: 0, y: 0, button: "none", action: "wheelup", shift: false },
      { type: "paste", text: "hello\nworld" },
      { type: "cellsize", width: 10, height: 20 },
    ]);
  });
});

describe("Screen", () => {
  it("diffs only changed cells", () => {
    const a = new Screen(10, 2);
    a.text(0, 0, "hello");
    const b = new Screen(10, 2);
    b.text(0, 0, "hellO");
    const out = diff(a, b);
    assert.match(out, /^\x1b\[1;5H/);
    assert.ok(out.includes("O") && !out.includes("hell"));
    assert.equal(diff(b, b), "");
  });

  it("truncates text with an ellipsis", () => {
    const s = new Screen(10, 1);
    s.text(0, 0, "abcdefghijkl", {}, 5);
    assert.equal(s.row(0).trimEnd(), "abcd…");
  });

  it("falls back to 256 colours", () => {
    const s = new Screen(1, 1);
    s.put(0, 0, "x", { fg: "#ff0000" });
    assert.match(diff(undefined, s, "256"), /38;5;196m/);
  });
});

describe("colorspace", () => {
  it("round-trips RGB through HSV", () => {
    for (const hex of ["#000000", "#ffffff", "#ff0080", "#1d4ed8", "#7928ca", "#808080"]) {
      const n = Number.parseInt(hex.slice(1), 16);
      const rgb = { r: n >> 16, g: (n >> 8) & 255, b: n & 255 };
      assert.equal(toHex(hsvToRgb(rgbToHsv(rgb))), hex);
    }
  });
});

describe("ColorPicker", () => {
  function picker(initial = "#1d4ed8", allowTransparent = false) {
    const changes: string[] = [];
    let done: string | undefined | null = null;
    const p = new ColorPicker({
      title: "Colour",
      initial,
      allowTransparent,
      onChange: (v) => changes.push(v),
      onDone: (v) => (done = v),
    });
    const s = new Screen(80, 24);
    const inner = { x: 1, y: 1, w: 66, h: 19 };
    p.render(s, inner);
    return { p, s, inner, changes, done: () => done };
  }

  it("accepts typed hex and CSS names", () => {
    const { p, changes, done } = picker();
    p.key(key("tab"));
    p.key(key("tab")); // wheel → value → text
    p.key(key("char", { ch: "u", ctrl: true }));
    for (const ch of "rebeccapurple") p.key(key("char", { ch }));
    assert.equal(changes.at(-1), "#663399");
    p.key(key("enter"));
    assert.equal(done(), "#663399");
  });

  it("moves around the wheel with arrow keys and cancels with Esc", () => {
    const { p, changes, done } = picker("#ff0000");
    p.key(key("left", { shift: true }));
    assert.notEqual(changes.at(-1), "#ff0000");
    p.key(key("escape"));
    assert.equal(done(), undefined);
  });

  it("picks hue and saturation by clicking the wheel", () => {
    const { p, inner, changes } = picker("#ffffff");
    // Wheel centre is white; its right-hand edge is pure red, top edge is green-yellow.
    const R = 13;
    const wheel = { x: inner.x + 1, y: inner.y };
    p.mouse(mouse(wheel.x + 2 * R, wheel.y + Math.floor(R / 2)));
    // A cell holds two pixel rows, so a click lands half a pixel off the axis: nearly pure red.
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(changes.at(-1)!.slice(i, i + 2), 16));
    assert.ok(r === 255 && g! < 20 && b! < 20, changes.at(-1));
    p.mouse(mouse(wheel.x + R, wheel.y, "drag"));
    assert.match(changes.at(-1)!, /^#[0-9a-f]{6}$/);
    assert.notEqual(changes.at(-1), "#ff0000");
  });

  it("picks from the palette and toggles transparency", () => {
    const { p, s, inner, changes, done } = picker("#ffffff", true);
    p.render(s, inner);
    p.mouse(mouse(inner.x + 1 + 3 * 2, inner.y + 15)); // third swatch, dark row
    assert.equal(changes.at(-1), "#b91c1c");
    p.key(key("tab")); // palette → transparent
    p.key(key("char", { ch: " " }));
    p.key(key("enter"));
    assert.equal(done(), "transparent");
  });
});

describe("FilePicker", () => {
  it("lists folders and images, filters, and chooses", () => {
    const dir = tmp();
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "logo.png"), "x");
    writeFileSync(join(dir, "notes.txt"), "x");
    let chosen: string | undefined | null = null;
    const fp = new FilePicker({ title: "Logo", start: dir, onDone: (p) => (chosen = p) });
    const s = new Screen(70, 24);
    fp.render(s, { x: 0, y: 0, w: 60, h: 20 });
    assert.match(s.toString(), /assets\//);
    assert.doesNotMatch(s.toString(), /notes\.txt/);
    fp.key(key("down")); // past ".."
    fp.key(key("enter"));
    for (const ch of "log") fp.key(key("char", { ch }));
    fp.render(s, { x: 0, y: 0, w: 60, h: 20 });
    fp.key(key("down"));
    fp.key(key("enter"));
    assert.equal(chosen, join(dir, "assets", "logo.png"));
  });
});

describe("App", () => {
  it("lays out URL bar, options and preview", async () => {
    const { app, text } = makeApp();
    await app.settle();
    keepScreen("tui-main", app.screen!);
    const t = text();
    assert.match(t.split("\n")[1]!, /URL\s+example\.com\/tui\s+✔/);
    for (const label of ["Options", "Preview", "Fill", "Colour", "Background", "Modules", "Eyes", "Image size", "Save PNG"]) {
      assert.ok(t.includes(label), label);
    }
    assert.match(t, /version 2 · 25×25 modules · ECL M · 1024px/);
  });

  it("changes options inline with ←/→ and the preview follows", async () => {
    const { app, send, text } = makeApp();
    await app.settle();
    const before = text();
    const modules = app["items"]().findIndex((i: { id: string }) => i.id === "style");
    for (let i = 0; i < modules; i++) send("down");
    send("right");
    assert.equal(app.design.style, "dots");
    await app.settle();
    assert.notEqual(text(), before, "pixel preview should change with the module style");
  });

  it("previews colour picks live and reverts on Esc", async () => {
    const { app, send, type } = makeApp();
    send("down", "enter"); // Colour → picker
    assert.ok(app.dialog);
    keepScreen("tui-picker", app.screen!);
    send("tab", "tab", key("char", { ch: "u", ctrl: true }));
    type("teal");
    assert.equal(app.design.fg, "#008080");
    send("escape");
    assert.equal(app.dialog, undefined);
    assert.equal(app.design.fg, "#000000");
  });

  it("chooses from a list popup", () => {
    const { app, send } = makeApp();
    const eyes = app["items"]().findIndex((i: { id: string }) => i.id === "eyeStyle");
    for (let i = 0; i < eyes; i++) send("down");
    send("enter");
    keepScreen("tui-list", app.screen!);
    send("down", "down", "enter");
    assert.equal(app.design.eyeStyle, "circle");
  });

  it("switches to a gradient, revealing its options", () => {
    const { app, send, text } = makeApp();
    send("right");
    assert.equal(app.design.fill, "linear");
    assert.match(text(), /Start colour[\s\S]*End colour[\s\S]*Angle\s+45°/);
    assert.deepEqual(designToRaw(app.design).gradient, "#000000,#7928ca");
  });

  it("edits the URL and flags invalid input", async () => {
    const { app, send, type, text } = makeApp();
    send("tab", key("char", { ch: "u", ctrl: true }));
    type("not a url");
    await app.settle();
    assert.match(text(), /✖ not a valid URL/);
    send(key("char", { ch: "u", ctrl: true }));
    type("anthropic.com");
    send("enter");
    await app.settle();
    assert.equal(app.design.url, "anthropic.com");
    assert.doesNotMatch(text(), /not a valid URL/);
  });

  it("saves with Ctrl-S, confirming before overwriting", async () => {
    const cwd = tmp();
    const { app, send } = makeApp({ cwd, raw: { style: "rounded" } });
    send(key("char", { ch: "s", ctrl: true }), key("char", { ch: "u", ctrl: true }));
    for (const ch of "out") app.handle(key("char", { ch }));
    send("enter");
    await new Promise((r) => setTimeout(r, 200));
    const file = join(cwd, "out.png");
    assert.ok(existsSync(file));
    assert.equal(await decodePng(readFileSync(file)), "https://example.com/tui");
    assert.deepEqual(app.saved, ["out.png"]);
    assert.match(app.command, /qrgen example\.com\/tui -o out\.png --style rounded/);

    // Saving again over the same name asks first; "n" leaves it alone.
    send(key("char", { ch: "s", ctrl: true }), "enter");
    await new Promise((r) => setImmediate(r));
    assert.match(app.screen!.toString(), /Overwrite out\.png\?/);
    send(key("char", { ch: "n" }));
    assert.equal(app.dialog, undefined);
  });

  it("chooses a logo through the file browser", async () => {
    const cwd = tmp();
    const c = createCanvas(64, 64);
    c.getContext("2d").fillRect(0, 0, 64, 64);
    writeFileSync(join(cwd, "logo.png"), c.toBuffer("image/png"));
    const { app, send } = makeApp({ cwd });
    const logo = app["items"]().findIndex((i: { id: string }) => i.id === "logo");
    for (let i = 0; i < logo; i++) send("down");
    send("enter");
    keepScreen("tui-files", app.screen!);
    send("down", "enter"); // skip ".." → logo.png
    assert.equal(app.design.logo, join(cwd, "logo.png"));
    await app.settle();
    assert.match(app.screen!.toString(), /ECL H/);
    send("delete");
    assert.equal(app.design.logo, undefined);
  });

  it("selects options with the mouse", () => {
    const { app, text } = makeApp();
    const y = text().split("\n").findIndex((l) => l.includes("Modules"));
    app.handle(mouse(5, y));
    app.handle(mouse(5, y)); // second click opens it
    assert.match(text(), /Module shape/);
  });

  it("places the image with Kitty graphics and moves it clear of popups", async () => {
    const { app, send, writes } = makeApp({ env: { TERM_PROGRAM: "ghostty", COLORTERM: "truecolor" } });
    await app.settle();
    const placements = () => writes.join("").match(/\x1b\[(\d+);(\d+)H\x1b_Ga=p,[^\x1b]*/g) ?? [];
    const first = placements().at(-1)!;
    assert.match(writes.join(""), /\x1b_Ga=t,f=100,i=\d+,q=2/);
    send("down", "enter");
    const moved = placements().at(-1)!;
    assert.notEqual(moved, first);
    const col = (p: string) => Number(p.match(/;(\d+)H/)![1]);
    assert.ok(col(moved) > 2 + app["layoutCache"]!.dialog!.w, "image starts right of the dialog");
  });

  it("quits with q and with Ctrl-C", () => {
    const a = makeApp();
    a.send(key("char", { ch: "q" }));
    assert.ok(a.exited());
    const b = makeApp();
    b.send("tab", key("char", { ch: "c", ctrl: true }));
    assert.ok(b.exited());
  });
});
