import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { isChar, type KeyEvent, type MouseEvent } from "../input.ts";
import { contains, type Rect, type Screen } from "../screen.ts";
import { theme } from "../theme.ts";
import type { Dialog } from "./dialog.ts";
import { TextInput } from "./text-input.ts";

const IMAGE = /\.(png|jpe?g|svg|webp|gif)$/i;

interface Entry {
  name: string;
  dir: boolean;
}

/** Browse folders and pick an image; typing filters the list. */
export class FilePicker implements Dialog {
  readonly title: string;
  private dir: string;
  private entries: Entry[] = [];
  private readonly filter = new TextInput();
  private index = 0;
  private scroll = 0;
  private error: string | undefined;
  private list: Rect | undefined;
  private readonly onDone: (path: string | undefined) => void;

  constructor(o: { title: string; start: string; onDone(path: string | undefined): void }) {
    this.title = o.title;
    this.onDone = o.onDone;
    this.dir = resolve(o.start);
    this.load();
  }

  private load() {
    this.error = undefined;
    try {
      this.entries = readdirSync(this.dir, { withFileTypes: true })
        .map((d) => {
          let dir = d.isDirectory();
          if (d.isSymbolicLink()) {
            try {
              dir = statSync(join(this.dir, d.name)).isDirectory();
            } catch {
              return undefined;
            }
          }
          return { name: d.name, dir };
        })
        .filter((e): e is Entry => e !== undefined && (e.dir || IMAGE.test(e.name)))
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    } catch (err) {
      this.entries = [];
      this.error = (err as Error).message;
    }
    this.index = 0;
    this.scroll = 0;
  }

  private visible(): Entry[] {
    const q = this.filter.value.toLowerCase();
    const shown = this.entries.filter((e) => (q.startsWith(".") || !e.name.startsWith(".")) && e.name.toLowerCase().includes(q));
    return dirname(this.dir) !== this.dir ? [{ name: "..", dir: true }, ...shown] : shown;
  }

  private cd(path: string) {
    this.dir = path;
    this.filter.set("");
    this.load();
  }

  private open(e: Entry | undefined) {
    if (!e) return;
    if (e.name === "..") this.cd(dirname(this.dir));
    else if (e.dir) this.cd(join(this.dir, e.name));
    else this.onDone(join(this.dir, e.name));
  }

  key(e: KeyEvent) {
    const items = this.visible();
    const page = Math.max(1, (this.list?.h ?? 10) - 1);
    if (e.name === "escape") {
      if (this.filter.value) this.filter.set("");
      else this.onDone(undefined);
    } else if (e.name === "enter") this.open(items[this.index]);
    else if (e.name === "up") this.index = Math.max(0, this.index - 1);
    else if (e.name === "down") this.index = Math.min(items.length - 1, this.index + 1);
    else if (e.name === "pageup") this.index = Math.max(0, this.index - page);
    else if (e.name === "pagedown") this.index = Math.min(items.length - 1, this.index + page);
    else if (e.name === "home") this.index = 0;
    else if (e.name === "end") this.index = items.length - 1;
    else if (e.name === "backspace" && !this.filter.value) this.cd(dirname(this.dir));
    else if (isChar(e, "~") && !this.filter.value) this.cd(homedir());
    else if (this.filter.handleKey(e) === "changed") {
      this.index = 0;
      // Typing an exact folder path jumps there.
      if (this.filter.value.endsWith("/")) {
        const target = resolve(this.dir, this.filter.value.replace(/^~(?=\/)/, homedir()));
        try {
          if (statSync(target).isDirectory()) this.cd(target);
        } catch {
          /* keep filtering */
        }
      }
    }
  }

  paste(text: string) {
    const target = resolve(this.dir, text.trim().replace(/^~(?=\/)/, homedir()));
    try {
      const st = statSync(target);
      if (st.isDirectory()) this.cd(target);
      else if (IMAGE.test(target)) this.onDone(target);
    } catch {
      this.filter.insert(text.trim());
    }
  }

  mouse(e: MouseEvent) {
    if (!this.list || !contains(this.list, e.x, e.y)) return;
    const items = this.visible();
    if (e.action === "wheelup") this.index = Math.max(0, this.index - 3);
    else if (e.action === "wheeldown") this.index = Math.min(items.length - 1, this.index + 3);
    else if (e.action === "down") {
      const i = this.scroll + e.y - this.list.y;
      if (i >= items.length) return;
      if (i === this.index) this.open(items[i]);
      else this.index = i;
    }
  }

  size(_maxW: number, maxH: number) {
    return { w: 60, h: Math.min(maxH, 22) };
  }

  render(s: Screen, inner: Rect) {
    const bg = theme.dialog;
    const home = homedir();
    const shown = this.dir.startsWith(home) ? `~${this.dir.slice(home.length)}` : this.dir;
    const path = shown.length > inner.w - 2 ? `…${shown.slice(-(inner.w - 3))}` : shown;
    s.text(inner.x + 1, inner.y, path, { fg: theme.accent, bg });
    const n = s.text(inner.x + 1, inner.y + 1, "Filter ", { fg: theme.dim, bg });
    this.filter.render(s, inner.x + 1 + n, inner.y + 1, inner.w - 2 - n, true);

    const list = (this.list = { x: inner.x, y: inner.y + 3, w: inner.w, h: inner.h - 4 });
    const items = this.visible();
    this.index = Math.max(0, Math.min(this.index, items.length - 1));
    if (this.index < this.scroll) this.scroll = this.index;
    if (this.index >= this.scroll + list.h) this.scroll = this.index - list.h + 1;

    if (this.error) s.text(list.x + 1, list.y, `✖ ${this.error}`, { fg: theme.error, bg }, list.w - 2);
    else if (items.length === 0) s.text(list.x + 1, list.y, "No images here (png, jpg, svg, webp, gif)", { fg: theme.dim, bg });
    for (let row = 0; row < list.h; row++) {
      const item = items[this.scroll + row];
      if (!item) break;
      const on = this.scroll + row === this.index;
      const rowBg = on ? theme.selection : bg;
      s.fill({ x: list.x, y: list.y + row, w: list.w, h: 1 }, { bg: rowBg });
      s.text(list.x + 1, list.y + row, `${item.dir ? "▸ " : "  "}${item.name}${item.dir && item.name !== ".." ? "/" : ""}`, {
        fg: item.dir ? theme.accent : on ? theme.text : theme.text,
        bold: on,
        bg: rowBg,
      }, list.w - 2);
    }
    const files = items.filter((i) => !i.dir).length;
    s.text(inner.x + 1, inner.y + inner.h - 1, `${files} image${files === 1 ? "" : "s"}`, { fg: theme.faint, bg });
  }

  hints() {
    return "↑↓ move · Enter open/choose · type to filter · ⌫ up a folder · ~ home · Esc cancel";
  }
}
