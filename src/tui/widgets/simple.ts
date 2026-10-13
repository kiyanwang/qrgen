import { isChar, type KeyEvent, type MouseEvent } from "../input.ts";
import { contains, type Rect, type Screen } from "../screen.ts";
import { theme } from "../theme.ts";
import type { Dialog } from "./dialog.ts";
import { TextInput } from "./text-input.ts";

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

/** Pick one option; moving the highlight previews it live, Esc reverts. */
export class ListDialog<T> implements Dialog {
  readonly title: string;
  private index: number;
  private inner: Rect | undefined;
  private readonly choices: Choice<T>[];
  private readonly onChange: (value: T) => void;
  private readonly onDone: (value: T | undefined) => void;

  constructor(o: {
    title: string;
    choices: Choice<T>[];
    current: T;
    onChange(value: T): void;
    onDone(value: T | undefined): void;
  }) {
    this.title = o.title;
    this.choices = o.choices;
    this.onChange = o.onChange;
    this.onDone = o.onDone;
    this.index = Math.max(0, o.choices.findIndex((c) => c.value === o.current));
  }

  size() {
    const width = Math.max(this.title.length + 6, ...this.choices.map((c) => c.label.length + (c.hint ? c.hint.length + 3 : 0) + 6));
    return { w: Math.min(56, width + 2), h: this.choices.length + 2 };
  }

  private move(to: number) {
    this.index = (to + this.choices.length) % this.choices.length;
    this.onChange(this.choices[this.index]!.value);
  }

  key(e: KeyEvent) {
    if (e.name === "escape") this.onDone(undefined);
    else if (e.name === "enter" || isChar(e, " ")) this.onDone(this.choices[this.index]!.value);
    else if (e.name === "up" || (e.name === "tab" && e.shift)) this.move(this.index - 1);
    else if (e.name === "down" || e.name === "tab") this.move(this.index + 1);
    else if (e.name === "home") this.move(0);
    else if (e.name === "end") this.move(this.choices.length - 1);
  }

  mouse(e: MouseEvent) {
    if (!this.inner || !contains(this.inner, e.x, e.y)) return;
    const i = e.y - this.inner.y;
    if (e.action === "wheelup") this.move(this.index - 1);
    else if (e.action === "wheeldown") this.move(this.index + 1);
    else if (e.action === "down" && i < this.choices.length) {
      if (i === this.index) this.onDone(this.choices[i]!.value);
      else this.move(i);
    }
  }

  render(s: Screen, inner: Rect) {
    this.inner = inner;
    this.choices.forEach((c, i) => {
      const on = i === this.index;
      const bg = on ? theme.selection : theme.dialog;
      s.fill({ x: inner.x, y: inner.y + i, w: inner.w, h: 1 }, { bg });
      const n = s.text(inner.x + 1, inner.y + i, `${on ? "▸" : " "} ${c.label}`, { fg: on ? theme.accent : theme.text, bold: on, bg });
      if (c.hint) s.text(inner.x + n + 3, inner.y + i, c.hint, { fg: theme.dim, bg }, inner.w - n - 4);
    });
  }

  hints() {
    return "↑↓ choose (previews live) · Enter OK · Esc cancel";
  }
}

/** Ask for one line of text, with validation. */
export class PromptDialog implements Dialog {
  readonly title: string;
  private readonly input: TextInput;
  private error: string | undefined;
  private inner: Rect | undefined;
  private readonly o: {
    title: string;
    label: string;
    initial: string;
    width?: number;
    validate?(value: string): string | undefined;
    onDone(value: string | undefined): void;
  };

  constructor(o: PromptDialog["o"]) {
    this.o = o;
    this.title = o.title;
    this.input = new TextInput(o.initial);
  }

  size(maxW: number) {
    return { w: Math.min(maxW, this.o.width ?? 56), h: 6 };
  }

  key(e: KeyEvent) {
    if (e.name === "escape") return this.o.onDone(undefined);
    if (e.name === "enter") {
      this.error = this.o.validate?.(this.input.value);
      if (!this.error) this.o.onDone(this.input.value);
      return;
    }
    if (this.input.handleKey(e) === "changed") this.error = undefined;
  }

  paste(text: string) {
    this.input.insert(text);
  }

  mouse(e: MouseEvent) {
    if (e.action === "down" && this.inner && e.y === this.inner.y + 1) this.input.clickAt(e.x - this.inner.x - 1);
  }

  render(s: Screen, inner: Rect) {
    this.inner = inner;
    s.text(inner.x + 1, inner.y, this.o.label, { fg: theme.dim, bg: theme.dialog });
    this.input.render(s, inner.x + 1, inner.y + 1, inner.w - 2, true);
    if (this.error) s.text(inner.x + 1, inner.y + 3, `✖ ${this.error}`, { fg: theme.error, bg: theme.dialog }, inner.w - 2);
  }

  hints() {
    return "Enter OK · Esc cancel";
  }
}

/** Yes / no question. */
export class ConfirmDialog implements Dialog {
  readonly title: string;
  private yes = false;
  private inner: Rect | undefined;
  private readonly o: { title: string; message: string; onDone(yes: boolean): void };

  constructor(o: ConfirmDialog["o"]) {
    this.o = o;
    this.title = o.title;
  }

  size(maxW: number) {
    return { w: Math.min(maxW, Math.max(40, this.o.message.length + 6)), h: 6 };
  }

  key(e: KeyEvent) {
    if (isChar(e, "y")) return this.o.onDone(true);
    if (isChar(e, "n") || e.name === "escape") return this.o.onDone(false);
    if (e.name === "enter") return this.o.onDone(this.yes);
    if (["left", "right", "tab"].includes(e.name)) this.yes = !this.yes;
  }

  mouse(e: MouseEvent) {
    if (e.action !== "down" || !this.inner || e.y !== this.inner.y + 2) return;
    const dx = e.x - this.inner.x;
    if (dx >= 1 && dx < 8) this.o.onDone(true);
    if (dx >= 10 && dx < 16) this.o.onDone(false);
  }

  render(s: Screen, inner: Rect) {
    this.inner = inner;
    const bg = theme.dialog;
    s.text(inner.x + 1, inner.y, this.o.message, { fg: theme.text, bg }, inner.w - 2);
    const button = (x: number, label: string, on: boolean) =>
      s.text(x, inner.y + 2, ` ${label} `, { fg: on ? theme.dialog : theme.text, bg: on ? theme.accent : theme.border, bold: on });
    button(inner.x + 1, "Yes", this.yes);
    button(inner.x + 10, "No", !this.yes);
  }

  hints() {
    return "y yes · n no · ←→ switch · Enter OK";
  }
}
