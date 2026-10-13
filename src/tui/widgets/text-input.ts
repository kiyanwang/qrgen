import type { KeyEvent } from "../input.ts";
import type { Screen, Style } from "../screen.ts";
import { theme } from "../theme.ts";

/** A single-line editable text field. */
export class TextInput {
  value: string;
  cursor: number;
  private scroll = 0;

  constructor(value = "") {
    this.value = value;
    this.cursor = [...value].length;
  }

  set(value: string) {
    this.value = value;
    this.cursor = [...value].length;
  }

  insert(text: string) {
    const chars = [...this.value];
    const add = [...text.replace(/[\r\n\t]+/g, " ")];
    chars.splice(this.cursor, 0, ...add);
    this.value = chars.join("");
    this.cursor += add.length;
  }

  /** Returns "changed" if the text changed, "handled" if only the cursor moved, false if not consumed. */
  handleKey(e: KeyEvent): "changed" | "handled" | false {
    const chars = [...this.value];
    const before = this.value;
    const wordLeft = () => {
      let i = this.cursor;
      while (i > 0 && chars[i - 1] === " ") i--;
      while (i > 0 && !/[\s/.:?&=#-]/.test(chars[i - 1]!)) i--;
      return i === this.cursor ? Math.max(0, i - 1) : i;
    };

    if (e.name === "left") this.cursor = e.ctrl || e.alt ? wordLeft() : Math.max(0, this.cursor - 1);
    else if (e.name === "right") this.cursor = Math.min(chars.length, this.cursor + 1);
    else if (e.name === "home" || (e.ctrl && e.ch === "a")) this.cursor = 0;
    else if (e.name === "end" || (e.ctrl && e.ch === "e")) this.cursor = chars.length;
    else if (e.name === "backspace") {
      if (this.cursor > 0) {
        const from = e.alt || e.ctrl ? wordLeft() : this.cursor - 1;
        chars.splice(from, this.cursor - from);
        this.cursor = from;
      }
    } else if (e.name === "delete") chars.splice(this.cursor, 1);
    else if (e.ctrl && e.ch === "u") {
      chars.splice(0, this.cursor);
      this.cursor = 0;
    } else if (e.ctrl && e.ch === "k") chars.splice(this.cursor);
    else if (e.ctrl && e.ch === "w") {
      const from = wordLeft();
      chars.splice(from, this.cursor - from);
      this.cursor = from;
    } else if (e.name === "char" && !e.ctrl && !e.alt && e.ch) {
      chars.splice(this.cursor, 0, e.ch);
      this.cursor++;
    } else return false;

    this.value = chars.join("");
    return this.value === before ? "handled" : "changed";
  }

  /** Place the cursor from a click at column offset `dx` within the field. */
  clickAt(dx: number) {
    this.cursor = Math.max(0, Math.min([...this.value].length, this.scroll + dx));
  }

  render(s: Screen, x: number, y: number, width: number, focused: boolean, style: Style = {}) {
    const bg = style.bg ?? theme.input;
    const chars = [...this.value];
    if (this.cursor < this.scroll) this.scroll = this.cursor;
    if (this.cursor >= this.scroll + width) this.scroll = this.cursor - width + 1;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, chars.length - width + 1)));
    s.fill({ x, y, w: width, h: 1 }, { bg });
    s.text(x, y, chars.slice(this.scroll, this.scroll + width).join(""), { fg: style.fg ?? theme.text, bg });
    if (focused) {
      const cx = x + this.cursor - this.scroll;
      s.put(cx, y, chars[this.cursor] ?? " ", { fg: bg, bg: theme.accent });
    }
  }
}
