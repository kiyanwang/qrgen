import { existsSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { commandLine } from "../command.ts";
import { generate, save } from "../generate.ts";
import { buildMatrix } from "../matrix.ts";
import { ERROR_LEVELS, EYE_STYLES, MODULE_STYLES, resolveOptions, type ErrorLevel, type ModuleStyle } from "../options.ts";
import { detectImageProtocol, kittyEscapes, pixelGrid, previewPng, supportsTrueColor, type PixelGrid } from "../preview.ts";
import { designToRaw, FILLS, type Design, type Fill } from "./design.ts";
import { isChar, isCtrl, type InputEvent, type KeyEvent, type MouseEvent } from "./input.ts";
import { contains, diff, Screen, type ColorMode, type Rect } from "./screen.ts";
import { theme } from "./theme.ts";
import { ColorPicker, drawSwatch } from "./widgets/color-picker.ts";
import type { Dialog } from "./widgets/dialog.ts";
import { FilePicker } from "./widgets/file-picker.ts";
import { ConfirmDialog, ListDialog, PromptDialog, type Choice } from "./widgets/simple.ts";
import { TextInput } from "./widgets/text-input.ts";

export interface AppHost {
  columns: number;
  rows: number;
  write(data: string): void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The user asked to quit. */
  exit(): void;
}

interface Item {
  id: string;
  label: string;
  value(): string;
  /** Colour shown as a swatch before the value. */
  swatch?(): string;
  /** ←/→ adjust the value in place. */
  step?(dir: 1 | -1): void;
  activate(): void;
  /** Delete/Backspace: reset to automatic / none. */
  clear?(): void;
}

type Row = { header: string } | Item;

interface Layout {
  url: Rect;
  sidebar: Rect;
  preview: Rect;
  status: number;
  dialog?: Rect;
  /** Where the code is drawn; undefined when a dialog leaves no room. */
  image?: Rect;
}

const SIDEBAR_W = 34;
const KITTY_ID = 7351;
const STATUS_MS = 6000;

const cycle = <T>(list: readonly T[], cur: T, dir: number): T =>
  list[(list.indexOf(cur) + dir + list.length) % list.length]!;

const FILL_LABEL: Record<Fill, string> = { solid: "Solid", linear: "Linear gradient", radial: "Radial gradient" };
const ECL_HINT: Record<ErrorLevel, string> = { L: "7%", M: "15%", Q: "25%", H: "30%" };

export class App {
  design: Design;
  output: string;
  readonly saved: string[] = [];
  focus: "url" | "sidebar";
  dialog: Dialog | undefined;

  private readonly host: AppHost;
  private readonly url: TextInput;
  private selected = "fill";
  private sidebarScroll = 0;
  private status: { text: string; kind: "ok" | "error" | "info"; at: number } | undefined;
  private readonly preview: {
    info?: string;
    warnings: string[];
    error?: string;
    png?: Buffer;
    version: number;
    grid?: PixelGrid;
  } = { warnings: [], version: 0 };
  private readonly protocol: "kitty" | undefined;
  private readonly colorMode: ColorMode;
  private cell = { width: 0, height: 0 };
  private prev: Screen | undefined;
  private placed: string | undefined;
  private transmitted = -1;
  private previewTimer: ReturnType<typeof setTimeout> | undefined;
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  /** What the current preview image was rendered from, to skip identical re-renders. */
  private renderedKey = "";
  private pending: Promise<void> = Promise.resolve();
  private layoutCache: Layout | undefined;
  private rowsCache: { row: Row; y: number }[] = [];

  constructor(host: AppHost, design: Design, output: string) {
    this.host = host;
    this.design = design;
    this.output = output;
    this.url = new TextInput(design.url);
    this.focus = design.url ? "sidebar" : "url";
    this.protocol = detectImageProtocol(host.env) === "kitty" ? "kitty" : undefined;
    this.colorMode = supportsTrueColor(host.env) ? "truecolor" : "256";
  }

  /** Initial paint and preview. */
  start() {
    this.render();
    this.schedulePreview(0);
  }

  /** Wait for any pending preview render (for tests). */
  async settle() {
    if (this.previewTimer) {
      clearTimeout(this.previewTimer);
      this.previewTimer = undefined;
      this.pending = this.updatePreview();
    }
    await this.pending;
  }

  get command(): string {
    return commandLine(this.design.url || "https://example.com", designToRaw(this.design), this.output);
  }

  flash(text: string, kind: "ok" | "error" | "info" = "info") {
    this.status = { text, kind, at: Date.now() };
    clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => this.render(), STATUS_MS + 50);
    this.statusTimer.unref?.();
  }

  // ---- events ----------------------------------------------------------------

  handle(e: InputEvent) {
    if (e.type === "cellsize") {
      if (e.width > 0 && e.height > 0) this.cell = { width: e.width, height: e.height };
      this.placed = undefined;
    } else if (e.type === "paste") {
      if (this.dialog) this.dialog.paste?.(e.text);
      else {
        this.focus = "url";
        this.url.insert(e.text.trim());
        this.urlChanged();
      }
    } else if (e.type === "mouse") this.onMouse(e);
    else this.onKey(e);
    this.render();
  }

  resize(columns: number, rows: number) {
    this.host.columns = columns;
    this.host.rows = rows;
    this.prev = undefined;
    this.placed = undefined;
    this.host.write("\x1b[2J");
    this.render();
    if (!this.protocol) this.schedulePreview(30);
  }

  private onKey(e: KeyEvent) {
    if (isCtrl(e, "c") || isCtrl(e, "q")) return this.host.exit();
    if (this.dialog) return this.dialog.key(e);
    if (isCtrl(e, "s")) return this.openSave();
    if (e.name === "tab") {
      this.focus = this.focus === "url" ? "sidebar" : "url";
      return;
    }

    if (this.focus === "url") {
      if (e.name === "enter" || e.name === "escape" || e.name === "down") this.focus = "sidebar";
      else if (this.url.handleKey(e) === "changed") this.urlChanged();
      return;
    }

    const item = this.item(this.selected);
    if (e.name === "up" || isChar(e, "k")) this.moveSelection(-1);
    else if (e.name === "down" || isChar(e, "j")) this.moveSelection(1);
    else if (e.name === "home") this.selected = this.items()[0]!.id;
    else if (e.name === "end") this.selected = this.items().at(-1)!.id;
    else if (e.name === "left" || isChar(e, "h")) item?.step?.(-1);
    else if (e.name === "right" || isChar(e, "l")) item?.step?.(1);
    else if (e.name === "enter" || isChar(e, " ")) item?.activate();
    else if (e.name === "backspace" || e.name === "delete" || isChar(e, "x")) item?.clear?.();
    else if (isChar(e, "/") || isChar(e, "u")) this.focus = "url";
    else if (isChar(e, "s")) this.openSave();
    else if (isChar(e, "q")) this.host.exit();
  }

  private onMouse(e: MouseEvent) {
    const L = this.layoutCache;
    if (!L) return;
    if (this.dialog) {
      if (e.action === "down" && L.dialog && !contains(L.dialog, e.x, e.y)) return;
      return this.dialog.mouse?.(e);
    }
    if (contains(L.url, e.x, e.y) && e.action === "down") {
      this.focus = "url";
      this.url.clickAt(e.x - (L.url.x + 7));
      return;
    }
    if (contains(L.sidebar, e.x, e.y)) {
      if (e.action === "wheelup") return this.moveSelection(-1);
      if (e.action === "wheeldown") return this.moveSelection(1);
      if (e.action !== "down") return;
      const hit = this.rowsCache.find((r) => r.y === e.y);
      if (!hit || "header" in hit.row) return;
      const item = hit.row;
      const valueX = L.sidebar.x + 15;
      if (this.focus === "sidebar" && this.selected === item.id) {
        // Clicking the ‹ › arrows steps; clicking elsewhere on the row opens it.
        if (item.step && e.x === valueX) item.step(-1);
        else if (item.step && e.x === L.sidebar.x + L.sidebar.w - 3) item.step(1);
        else item.activate();
      }
      this.focus = "sidebar";
      this.selected = item.id;
    }
  }

  private moveSelection(dir: 1 | -1) {
    const items = this.items();
    const i = items.findIndex((it) => it.id === this.selected);
    this.selected = items[Math.max(0, Math.min(items.length - 1, i + dir))]!.id;
  }

  private urlChanged() {
    this.design.url = this.url.value.trim();
    this.schedulePreview();
  }

  private changed() {
    this.schedulePreview();
    this.render();
  }

  // ---- dialogs ---------------------------------------------------------------

  private open(dialog: Dialog) {
    this.dialog = dialog;
    this.render();
  }

  private close() {
    this.dialog = undefined;
    this.changed();
  }

  private pickColor(title: string, get: () => string, set: (v: string) => void, opts: { transparent?: boolean } = {}) {
    const before = get();
    const d = this.design;
    const against = title === "Background" ? { color: d.fg, label: "foreground" } : { color: d.bg, label: "background" };
    this.open(
      new ColorPicker({
        title,
        initial: before,
        allowTransparent: opts.transparent,
        against,
        onChange: (v) => {
          set(v);
          this.changed();
        },
        onDone: (v) => {
          set(v ?? before);
          this.close();
        },
      }),
    );
  }

  private pickChoice<T>(title: string, choices: Choice<T>[], get: () => T, set: (v: T) => void) {
    const before = get();
    this.open(
      new ListDialog({
        title,
        choices,
        current: before,
        onChange: (v) => {
          set(v);
          this.changed();
        },
        onDone: (v) => {
          set(v === undefined ? before : v);
          this.close();
        },
      }),
    );
  }

  private prompt(title: string, label: string, initial: string, validate: (v: string) => string | undefined, done: (v: string) => void) {
    this.open(
      new PromptDialog({
        title,
        label,
        initial,
        validate,
        onDone: (v) => {
          if (v !== undefined) done(v.trim());
          this.close();
        },
      }),
    );
  }

  private openSave() {
    this.prompt("Save PNG", "File name", this.output, (v) => (v.trim() ? undefined : "Enter a file name"), (v) => {
      const path = extname(v) ? v : `${v}.png`;
      if (existsSync(resolve(this.host.cwd, path))) {
        // Defer so the prompt closes first.
        queueMicrotask(() =>
          this.open(
            new ConfirmDialog({
              title: "File exists",
              message: `Overwrite ${path}?`,
              onDone: (yes) => {
                this.dialog = undefined;
                if (yes) void this.saveTo(path);
                this.render();
              },
            }),
          ),
        );
      } else void this.saveTo(path);
    });
  }

  async saveTo(path: string) {
    try {
      const { options } = resolveOptions(this.design.url, designToRaw(this.design));
      const result = await generate(options);
      await save(result.png, resolve(this.host.cwd, path));
      this.output = path;
      if (!this.saved.includes(path)) this.saved.push(path);
      this.flash(`✔ Saved ${path} · ${options.size}px · version ${result.version}`, "ok");
    } catch (err) {
      this.flash(`✖ ${(err as Error).message}`, "error");
    }
    this.render();
  }

  // ---- sidebar model -----------------------------------------------------------

  private rows(): Row[] {
    const d = this.design;
    const gradient = d.fill !== "solid";
    const rows: (Row | false)[] = [
      { header: "COLOUR" },
      {
        id: "fill",
        label: "Fill",
        value: () => FILL_LABEL[d.fill],
        step: (dir) => {
          d.fill = cycle(FILLS, d.fill, dir);
          this.changed();
        },
        activate: () =>
          this.pickChoice(
            "Fill",
            FILLS.map((f) => ({ value: f, label: FILL_LABEL[f] })),
            () => d.fill,
            (v) => (d.fill = v),
          ),
      },
      {
        id: "fg",
        label: gradient ? "Start colour" : "Colour",
        value: () => d.fg,
        swatch: () => d.fg,
        activate: () => this.pickColor(gradient ? "Gradient start" : "Foreground", () => d.fg, (v) => (d.fg = v)),
      },
      gradient && {
        id: "fg2",
        label: "End colour",
        value: () => d.fg2,
        swatch: () => d.fg2,
        activate: () => this.pickColor("Gradient end", () => d.fg2, (v) => (d.fg2 = v)),
      },
      d.fill === "linear" && {
        id: "angle",
        label: "Angle",
        value: () => `${d.angle}°`,
        step: (dir) => {
          d.angle = (((d.angle + dir * 15) % 360) + 360) % 360;
          this.changed();
        },
        activate: () =>
          this.pickChoice(
            "Gradient direction",
            [0, 45, 90, 135, 180, 225, 270, 315].map((a) => ({ value: a, label: `${"→↘↓↙←↖↑↗"[a / 45]} ${a}°` })),
            () => d.angle,
            (v) => (d.angle = v),
          ),
      },
      {
        id: "bg",
        label: "Background",
        value: () => d.bg,
        swatch: () => d.bg,
        activate: () => this.pickColor("Background", () => d.bg, (v) => (d.bg = v), { transparent: true }),
      },
      {
        id: "eye",
        label: "Eye colour",
        value: () => d.eyeColor ?? "same",
        swatch: () => d.eyeColor ?? d.fg,
        activate: () => this.pickColor("Eye colour", () => d.eyeColor ?? d.fg, (v) => (d.eyeColor = v)),
        clear: () => {
          d.eyeColor = undefined;
          this.changed();
        },
      },
      { header: "SHAPE" },
      {
        id: "style",
        label: "Modules",
        value: () => d.style,
        step: (dir) => {
          d.style = cycle(MODULE_STYLES, d.style, dir);
          this.changed();
        },
        activate: () =>
          this.pickChoice<ModuleStyle>(
            "Module shape",
            [
              { value: "square", label: "square", hint: "classic" },
              { value: "dots", label: "dots", hint: "circles" },
              { value: "rounded", label: "rounded", hint: "soft, connected" },
            ],
            () => d.style,
            (v) => (d.style = v),
          ),
      },
      {
        id: "eyeStyle",
        label: "Eyes",
        value: () => d.eyeStyle,
        step: (dir) => {
          d.eyeStyle = cycle(EYE_STYLES, d.eyeStyle, dir);
          this.changed();
        },
        activate: () =>
          this.pickChoice(
            "Eye shape",
            EYE_STYLES.map((s) => ({ value: s, label: s })),
            () => d.eyeStyle,
            (v) => (d.eyeStyle = v),
          ),
      },
      { header: "LOGO" },
      {
        id: "logo",
        label: "Image",
        value: () => (d.logo ? relative(this.host.cwd, d.logo) || d.logo : "none"),
        activate: () =>
          this.open(
            new FilePicker({
              title: "Choose a logo",
              start: d.logo ? resolve(this.host.cwd, d.logo, "..") : this.host.cwd,
              onDone: (path) => {
                if (path) d.logo = path;
                this.close();
              },
            }),
          ),
        clear: () => {
          d.logo = undefined;
          this.changed();
        },
      },
      Boolean(d.logo) && {
        id: "logoSize",
        label: "Logo size",
        value: () => `${Math.round(d.logoSize * 100)}%`,
        step: (dir) => {
          d.logoSize = Math.round(Math.min(0.3, Math.max(0.1, d.logoSize + dir * 0.02)) * 100) / 100;
          this.changed();
        },
        activate: () =>
          this.pickChoice(
            "Logo size",
            [
              { value: 0.15, label: "Small", hint: "15%" },
              { value: 0.22, label: "Medium", hint: "22%" },
              { value: 0.3, label: "Large", hint: "30% · harder to scan" },
            ],
            () => d.logoSize,
            (v) => (d.logoSize = v),
          ),
      },
      { header: "OUTPUT" },
      {
        id: "size",
        label: "Image size",
        value: () => `${d.size}px`,
        step: (dir) => {
          const presets = [256, 512, 768, 1024, 1536, 2048, 3072, 4096];
          const next = dir > 0 ? presets.find((p) => p > d.size) : presets.findLast((p) => p < d.size);
          d.size = next ?? d.size;
          this.changed();
        },
        activate: () =>
          this.prompt(
            "Image size",
            "Width and height in pixels (64–8192)",
            String(d.size),
            (v) => (/^\d+$/.test(v.trim()) && +v >= 64 && +v <= 8192 ? undefined : "Enter a whole number from 64 to 8192"),
            (v) => (d.size = Number(v)),
          ),
      },
      {
        id: "margin",
        label: "Margin",
        value: () => `${d.margin} modules`,
        step: (dir) => {
          d.margin = Math.max(0, Math.min(20, d.margin + dir));
          this.changed();
        },
        activate: () =>
          this.prompt(
            "Margin",
            "Quiet zone in modules (0–20, 4 recommended)",
            String(d.margin),
            (v) => (/^\d+$/.test(v.trim()) && +v <= 20 ? undefined : "Enter a whole number from 0 to 20"),
            (v) => (d.margin = Number(v)),
          ),
      },
      {
        id: "ecl",
        label: "Error corr.",
        value: () => (d.ecl ? `${d.ecl} · ${ECL_HINT[d.ecl]}` : `auto · ${d.logo ? "H" : "M"}`),
        step: (dir) => {
          const all = [undefined, ...ERROR_LEVELS];
          d.ecl = cycle(all, d.ecl, dir);
          this.changed();
        },
        activate: () =>
          this.pickChoice<ErrorLevel | "auto">(
            "Error correction",
            [
              { value: "auto", label: "auto", hint: "M, or H with a logo" },
              ...ERROR_LEVELS.map((l) => ({ value: l, label: l, hint: `${ECL_HINT[l]} recoverable` })),
            ],
            () => d.ecl ?? "auto",
            (v) => (d.ecl = v === "auto" ? undefined : v),
          ),
        clear: () => {
          d.ecl = undefined;
          this.changed();
        },
      },
      { header: "" },
      { id: "save", label: "Save PNG…", value: () => "^S", activate: () => this.openSave() },
      { id: "quit", label: "Quit", value: () => "q", activate: () => this.host.exit() },
    ];
    return rows.filter((r): r is Row => Boolean(r));
  }

  private items(): Item[] {
    return this.rows().filter((r): r is Item => !("header" in r));
  }

  private item(id: string): Item | undefined {
    const items = this.items();
    const found = items.find((i) => i.id === id);
    if (!found) this.selected = items[0]!.id;
    return found;
  }

  // ---- preview -------------------------------------------------------------------

  private schedulePreview(delay = 60) {
    clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      this.previewTimer = undefined;
      this.pending = this.updatePreview();
    }, delay);
  }

  private async updatePreview() {
    const seq = ++this.seq;
    const p = this.preview;
    try {
      if (!this.design.url) throw new Error("Type a URL above to see your code");
      const { options, warnings } = resolveOptions(this.design.url, designToRaw(this.design));
      const m = buildMatrix(options.data, options.ecl);
      const area = this.protocol ? undefined : this.layout().image;
      const px = area ? Math.max(8, Math.min(area.w, area.h * 2)) : 64;
      const key = JSON.stringify([options, this.protocol ? 720 : px]);
      if (key === this.renderedKey && !p.error) {
        p.warnings = warnings;
        return this.render();
      }
      if (this.protocol) {
        const png = await previewPng(options, 720);
        if (seq !== this.seq) return;
        p.png = png;
        p.version++;
      } else {
        const grid = await pixelGrid(options, px);
        if (seq !== this.seq) return;
        p.grid = grid;
      }
      this.renderedKey = key;
      p.error = undefined;
      p.warnings = warnings;
      p.info = `version ${m.version} · ${m.size}×${m.size} modules · ECL ${options.ecl} · ${options.size}px`;
    } catch (err) {
      if (seq !== this.seq) return;
      this.renderedKey = "";
      p.error = (err as Error).message;
      p.warnings = [];
    }
    this.render();
  }

  // ---- layout & drawing --------------------------------------------------------

  private layout(): Layout {
    const W = this.host.columns;
    const H = this.host.rows;
    const mainH = H - 4;
    const L: Layout = {
      url: { x: 0, y: 0, w: W, h: 3 },
      sidebar: { x: 0, y: 3, w: SIDEBAR_W, h: mainH },
      preview: { x: SIDEBAR_W, y: 3, w: W - SIDEBAR_W, h: mainH },
      status: H - 1,
    };
    const infoLines = 1 + Math.min(2, this.preview.warnings.length) + (this.preview.error ? 1 : 0);
    let image: Rect | undefined = {
      x: L.preview.x + 2,
      y: L.preview.y + 1,
      w: L.preview.w - 4,
      h: L.preview.h - 3 - infoLines,
    };
    if (this.dialog) {
      const size = this.dialog.size(W - 4, mainH);
      const w = Math.min(size.w, W - 4);
      const h = Math.min(size.h, H - 5);
      // Small popups open beside the option being edited; big ones take the top left.
      const row = this.rowsCache.find((r) => !("header" in r.row) && r.row.id === this.selected);
      L.dialog =
        h <= 12 && row
          ? { x: 16, y: Math.max(4, Math.min(row.y - 1, H - 2 - h)), w, h }
          : { x: 2, y: 4, w, h };
      const right = L.dialog.x + L.dialog.w + 1;
      if (image.x < right) {
        image.w -= right - image.x;
        image.x = right;
      }
    }
    if (image.w < 10 || image.h < 5) image = undefined;
    L.image = image;
    return L;
  }

  render() {
    const W = this.host.columns;
    const H = this.host.rows;
    const s = new Screen(W, H);
    s.fill({ x: 0, y: 0, w: W, h: H }, { bg: theme.bg, fg: theme.text });
    if (W < 72 || H < 22) {
      s.text(1, 0, `qrgen needs at least 72×22 (this is ${W}×${H})`, { fg: theme.warn });
      this.layoutCache = undefined;
      return this.flush(s, undefined);
    }
    const L = (this.layoutCache = this.layout());
    this.drawUrl(s, L.url);
    this.drawSidebar(s, L.sidebar);
    const image = this.drawPreview(s, L);
    this.drawStatus(s, L.status);
    if (this.dialog && L.dialog) {
      s.box(L.dialog, {
        border: { fg: theme.dialogBorder, bg: theme.dialog },
        title: this.dialog.title,
        titleStyle: { fg: theme.text, bg: theme.dialog, bold: true },
        fill: { bg: theme.dialog },
      });
      this.dialog.render(s, { x: L.dialog.x + 1, y: L.dialog.y + 1, w: L.dialog.w - 2, h: L.dialog.h - 2 });
    }
    this.flush(s, image);
  }

  /** The last frame drawn, for tests and snapshots. */
  get screen(): Screen | undefined {
    return this.prev;
  }

  private drawUrl(s: Screen, r: Rect) {
    const focused = this.focus === "url" && !this.dialog;
    s.box(r, {
      border: { fg: focused ? theme.borderFocus : theme.border, bg: theme.bg },
      title: "qrgen",
      titleStyle: { fg: theme.badge, bg: theme.bg, bold: true },
    });
    const label = this.design.raw ? "Text" : "URL";
    s.text(r.x + 2, r.y + 1, label, { fg: focused ? theme.accent : theme.dim, bold: true, bg: theme.bg });
    let status = "";
    let statusFg: string = theme.ok;
    if (this.design.url) {
      try {
        resolveOptions(this.design.url, { raw: this.design.raw });
        status = "✔";
      } catch {
        status = "✖ not a valid URL";
        statusFg = theme.error;
      }
    }
    const inputW = r.w - 9 - (status.length + 2);
    this.url.render(s, r.x + 7, r.y + 1, inputW, focused, { bg: theme.input });
    if (!this.url.value && !focused) s.text(r.x + 8, r.y + 1, "https://example.com", { fg: theme.faint, bg: theme.input });
    s.text(r.x + 8 + inputW, r.y + 1, status, { fg: statusFg, bg: theme.bg });
  }

  private drawSidebar(s: Screen, r: Rect) {
    const focused = this.focus === "sidebar" && !this.dialog;
    s.box(r, {
      border: { fg: focused ? theme.borderFocus : theme.border, bg: theme.panel },
      title: "Options",
      titleStyle: { fg: theme.text, bg: theme.panel, bold: true },
      fill: { bg: theme.panel },
    });
    const rows = this.rows();
    this.item(this.selected); // re-home the selection if its row disappeared
    const inner = { x: r.x + 1, y: r.y + 1, w: r.w - 2, h: r.h - 2 };
    const selIndex = rows.findIndex((row) => !("header" in row) && row.id === this.selected);
    if (selIndex < this.sidebarScroll) this.sidebarScroll = Math.max(0, selIndex - 1);
    if (selIndex >= this.sidebarScroll + inner.h) this.sidebarScroll = selIndex - inner.h + 1;

    this.rowsCache = [];
    rows.slice(this.sidebarScroll, this.sidebarScroll + inner.h).forEach((row, i) => {
      const y = inner.y + i;
      this.rowsCache.push({ row, y });
      if ("header" in row) {
        s.text(inner.x + 1, y, row.header, { fg: theme.faint, bold: true, bg: theme.panel });
        return;
      }
      const on = row.id === this.selected;
      const bg = on && focused ? theme.selection : theme.panel;
      s.fill({ x: inner.x, y, w: inner.w, h: 1 }, { bg });
      s.text(inner.x, y, on ? "▎" : " ", { fg: focused ? theme.accent : theme.dim, bg });
      s.text(inner.x + 1, y, row.label, { fg: on ? theme.text : theme.dim, bold: on, bg }, 13);

      let x = inner.x + 14;
      const valueW = inner.w - 14;
      const arrows = on && focused && row.step;
      if (arrows) s.put(x, y, "‹", { fg: theme.accent, bg });
      x += 1;
      const swatch = row.swatch?.();
      if (swatch) {
        drawSwatch(s, { x, y, w: 2, h: 1 }, swatch);
        x += 3;
      }
      const isAction = row.id === "save" || row.id === "quit";
      s.text(x, y, row.value(), { fg: isAction ? theme.faint : theme.text, bg }, valueW - (x - inner.x - 14) - 2);
      if (arrows) s.put(inner.x + inner.w - 1, y, "›", { fg: theme.accent, bg });
    });
  }

  /** Draws the preview panel; returns where the image goes (cells), if anywhere. */
  private drawPreview(s: Screen, L: Layout): Rect | undefined {
    const r = L.preview;
    const p = this.preview;
    s.box(r, {
      border: { fg: theme.border, bg: theme.bg },
      title: "Preview",
      titleStyle: { fg: theme.text, bg: theme.bg, bold: true },
    });

    // Info and warnings along the bottom of the panel.
    let y = r.y + r.h - 2;
    const lineW = r.w - 4;
    if (p.info && !p.error) s.text(r.x + 2, y--, p.info, { fg: theme.dim, bg: theme.bg }, lineW);
    for (const w of p.warnings.slice(0, 2).reverse()) s.text(r.x + 2, y--, `▲ ${w}`, { fg: theme.warn, bg: theme.bg }, lineW);
    if (p.error) {
      const empty = !this.design.url;
      s.text(r.x + 2, y--, `${empty ? "" : "✖ "}${p.error}`, { fg: empty ? theme.dim : theme.error, bg: theme.bg }, lineW);
    }

    const area = L.image;
    if (!area) return undefined;
    if (this.protocol) {
      if (!p.png) return undefined;
      // Fit a square image: a cell is `aspect` times taller than wide.
      const aspect = this.cell.width ? this.cell.height / this.cell.width : 2;
      const rows = Math.max(1, Math.min(area.h, Math.floor(area.w / aspect)));
      const cols = Math.max(1, Math.round(rows * aspect));
      return { x: area.x + Math.floor((area.w - cols) / 2), y: area.y + Math.floor((area.h - rows) / 2), w: cols, h: rows };
    }
    const g = p.grid;
    if (!g) return undefined;
    const rows = Math.ceil(g.size / 2);
    const x0 = area.x + Math.max(0, Math.floor((area.w - g.size) / 2));
    const y0 = area.y + Math.max(0, Math.floor((area.h - rows) / 2));
    for (let row = 0; row < Math.min(rows, area.h); row++) {
      for (let x = 0; x < Math.min(g.size, area.w); x++) {
        const top = g.at(x, row * 2);
        const bottom = row * 2 + 1 < g.size ? g.at(x, row * 2 + 1) : theme.bg;
        s.put(x0 + x, y0 + row, "▀", { fg: top, bg: bottom });
      }
    }
    if (g.size !== Math.max(8, Math.min(area.w, area.h * 2)) && !this.previewTimer) this.schedulePreview(30);
    return undefined;
  }

  private drawStatus(s: Screen, y: number) {
    const W = this.host.columns;
    s.fill({ x: 0, y, w: W, h: 1 }, { bg: theme.panel });
    const hints = this.dialog
      ? this.dialog.hints()
      : this.focus === "url"
        ? "type or paste a URL · Enter/Tab to options · ^S save · ^C quit"
        : "↑↓ select · ←→ change · Enter edit · ⌫ reset · Tab URL · ^S save · q quit";
    const msg = this.status && Date.now() - this.status.at < STATUS_MS ? this.status : undefined;
    const msgW = msg ? Math.min([...msg.text].length + 2, Math.floor(W / 2)) : 0;
    s.text(1, y, hints, { fg: theme.dim, bg: theme.panel }, W - msgW - 3);
    if (msg) {
      const fg = msg.kind === "ok" ? theme.ok : msg.kind === "error" ? theme.error : theme.text;
      s.text(W - msgW, y, msg.text, { fg, bg: theme.panel, bold: true }, msgW - 1);
    }
  }

  private flush(s: Screen, image: Rect | undefined) {
    let out = diff(this.prev, s, this.colorMode);
    this.prev = s;

    if (this.protocol) {
      const png = this.preview.png;
      const key = image && png ? `${this.preview.version}@${image.x},${image.y},${image.w}x${image.h}` : undefined;
      if (key !== this.placed) {
        if (!key || !png || !image) out += `\x1b_Ga=d,d=i,i=${KITTY_ID},q=2\x1b\\`;
        else {
          if (this.transmitted !== this.preview.version) {
            out += kittyEscapes(png, `a=t,f=100,i=${KITTY_ID},q=2`);
            this.transmitted = this.preview.version;
          }
          out += `\x1b7\x1b[${image.y + 1};${image.x + 1}H\x1b_Ga=p,i=${KITTY_ID},p=1,q=2,C=1,c=${image.w},r=${image.h}\x1b\\\x1b8`;
        }
        this.placed = key;
      }
    }
    if (out) this.host.write(out);
  }

  /** Escape sequence that removes the preview image (on exit). */
  static readonly cleanup = `\x1b_Ga=d,d=I,i=${KITTY_ID},q=2\x1b\\`;
}
