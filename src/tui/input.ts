/** Parse raw terminal input (keys, SGR mouse, bracketed paste, size reports) into events. */

export interface KeyEvent {
  type: "key";
  /** "char" for printable/ctrl characters, otherwise e.g. "up", "enter", "pagedown". */
  name: string;
  ch?: string;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface MouseEvent {
  type: "mouse";
  /** 0-based cell coordinates. */
  x: number;
  y: number;
  button: "left" | "middle" | "right" | "none";
  action: "down" | "up" | "drag" | "move" | "wheelup" | "wheeldown";
  shift: boolean;
}

export interface PasteEvent {
  type: "paste";
  text: string;
}

/** Reply to CSI 16 t: the pixel size of one character cell. */
export interface CellSizeEvent {
  type: "cellsize";
  width: number;
  height: number;
}

export type InputEvent = KeyEvent | MouseEvent | PasteEvent | CellSizeEvent;

const PASTE_END = "\x1b[201~";

export const key = (name: string, mods: Partial<Omit<KeyEvent, "type" | "name">> = {}): KeyEvent => ({
  type: "key",
  name,
  ctrl: false,
  alt: false,
  shift: false,
  ...mods,
});

const CSI_TILDE: Record<string, string> = {
  "1": "home",
  "7": "home",
  "4": "end",
  "8": "end",
  "2": "insert",
  "3": "delete",
  "5": "pageup",
  "6": "pagedown",
};
const CSI_LETTER: Record<string, string> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };

/** Modifier parameter (xterm style: 1 + shift|alt<<1|ctrl<<2). */
function mods(param: string | undefined) {
  const m = Math.max(0, Number(param ?? 1) - 1);
  return { shift: (m & 1) !== 0, alt: (m & 2) !== 0, ctrl: (m & 4) !== 0 };
}

export class InputParser {
  private buf = "";
  private paste: string | undefined;

  /** True when a lone ESC (or partial sequence) is waiting: call flush() after a short timeout. */
  get pending(): boolean {
    return this.buf.length > 0;
  }

  feed(data: string): InputEvent[] {
    this.buf += data;
    return this.drain(false);
  }

  /** Treat whatever is buffered as complete (a lone ESC becomes the Escape key). */
  flush(): InputEvent[] {
    return this.drain(true);
  }

  private drain(force: boolean): InputEvent[] {
    const out: InputEvent[] = [];
    while (this.buf.length) {
      if (this.paste !== undefined) {
        const end = this.buf.indexOf(PASTE_END);
        if (end < 0) {
          this.paste += this.buf;
          this.buf = "";
          break;
        }
        out.push({ type: "paste", text: this.paste + this.buf.slice(0, end) });
        this.paste = undefined;
        this.buf = this.buf.slice(end + PASTE_END.length);
        continue;
      }
      const consumed = this.parseOne(out, force);
      if (consumed === 0) break;
      this.buf = this.buf.slice(consumed);
    }
    return out;
  }

  /** Parse one event from the start of the buffer; returns characters consumed (0 = need more). */
  private parseOne(out: InputEvent[], force: boolean): number {
    const b = this.buf;
    const c = b[0]!;
    if (c === "\x1b") {
      if (b.length === 1) {
        if (!force) return 0;
        out.push(key("escape"));
        return 1;
      }
      if (b[1] === "[") return this.parseCsi(out, force);
      if (b[1] === "O") {
        if (b.length < 3) {
          if (!force) return 0;
          out.push(key("char", { ch: "O", alt: true }));
          return 2;
        }
        const name = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" }[b[2]!];
        if (name) out.push(key(name));
        return 3;
      }
      if (b[1] === "\x1b") {
        out.push(key("escape"));
        return 1;
      }
      // Alt + key.
      const [ev, n] = this.plain(b.slice(1));
      out.push({ ...ev, alt: true });
      return 1 + n;
    }
    const [ev, n] = this.plain(b);
    out.push(ev);
    return n;
  }

  private plain(b: string): [KeyEvent, number] {
    const cp = b.codePointAt(0)!;
    const ch = String.fromCodePoint(cp);
    if (ch === "\r" || ch === "\n") return [key("enter"), 1];
    if (ch === "\t") return [key("tab"), 1];
    if (ch === "\x7f" || ch === "\b") return [key("backspace"), 1];
    if (cp < 0x20) return [key("char", { ch: String.fromCharCode(cp + 96), ctrl: true }), 1];
    return [key("char", { ch }), ch.length];
  }

  private parseCsi(out: InputEvent[], force: boolean): number {
    const b = this.buf;
    let i = 2;
    while (i < b.length && b.charCodeAt(i) >= 0x20 && b.charCodeAt(i) <= 0x3f) i++;
    if (i >= b.length) {
      if (!force && b.length < 64) return 0;
      out.push(key("escape"));
      return 1;
    }
    const final = b[i]!;
    const body = b.slice(2, i);
    const len = i + 1;

    if (body.startsWith("<") && (final === "M" || final === "m")) {
      const [code = 0, x = 1, y = 1] = body.slice(1).split(";").map(Number);
      const buttons = ["left", "middle", "right", "none"] as const;
      let action: MouseEvent["action"];
      if (code & 64) action = code & 1 ? "wheeldown" : "wheelup";
      else if (final === "m") action = "up";
      else if (code & 32) action = (code & 3) === 3 ? "move" : "drag";
      else action = "down";
      out.push({
        type: "mouse",
        x: x - 1,
        y: y - 1,
        button: code & 64 ? "none" : buttons[code & 3]!,
        action,
        shift: (code & 4) !== 0,
      });
      return len;
    }
    if (body === "200" && final === "~") {
      this.paste = "";
      return len;
    }
    const params = body.split(";");
    if (final === "t" && params[0] === "6") {
      out.push({ type: "cellsize", height: Number(params[1]), width: Number(params[2]) });
      return len;
    }
    if (final === "Z") {
      out.push(key("tab", { shift: true }));
      return len;
    }
    if (final === "~" && CSI_TILDE[params[0]!]) {
      out.push(key(CSI_TILDE[params[0]!]!, mods(params[1])));
      return len;
    }
    if (CSI_LETTER[final]) {
      out.push(key(CSI_LETTER[final]!, mods(params[1])));
      return len;
    }
    return len; // unknown sequence: swallow it
  }
}

export const isChar = (e: KeyEvent, ch?: string) => e.name === "char" && !e.ctrl && !e.alt && (ch === undefined || e.ch === ch);
export const isCtrl = (e: KeyEvent, ch: string) => e.name === "char" && e.ctrl && e.ch === ch;
