import { writeSync } from "node:fs";
import { InputParser, type InputEvent } from "./input.ts";

const ENTER = [
  "\x1b[?1049h", // alternate screen
  "\x1b[?25l", // hide cursor
  "\x1b[?7l", // no autowrap, so the bottom-right cell never scrolls
  "\x1b[?1000h\x1b[?1002h\x1b[?1006h", // mouse clicks + drags, SGR coordinates
  "\x1b[?2004h", // bracketed paste
  "\x1b[2J",
  "\x1b[16t", // ask for the cell size in pixels, to keep the preview square
].join("");

const LEAVE = ["\x1b[?2004l", "\x1b[?1006l\x1b[?1002l\x1b[?1000l", "\x1b[?7h", "\x1b[0m", "\x1b[?25h", "\x1b[?1049l"].join("");

/** Owns the TTY while the editor runs: raw input, alternate screen, mouse. */
export class Terminal {
  private readonly parser = new InputParser();
  private escTimer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private onData: ((data: string) => void) | undefined;
  private onResize: (() => void) | undefined;
  private extraCleanup = "";

  get columns() {
    return process.stdout.columns || 80;
  }

  get rows() {
    return process.stdout.rows || 24;
  }

  write(data: string) {
    process.stdout.write(data);
  }

  start(onEvent: (e: InputEvent) => void, onResize: () => void, cleanup = "") {
    this.active = true;
    this.extraCleanup = cleanup;
    process.stdin.setRawMode(true);
    process.stdin.setEncoding("utf8");
    this.onData = (data) => {
      clearTimeout(this.escTimer);
      for (const e of this.parser.feed(data)) onEvent(e);
      // A lone ESC might be the start of a sequence; wait briefly before treating it as the Escape key.
      if (this.parser.pending) this.escTimer = setTimeout(() => this.parser.flush().forEach(onEvent), 30);
    };
    this.onResize = onResize;
    process.stdin.on("data", this.onData);
    process.stdout.on("resize", onResize);
    process.stdin.resume();
    process.once("exit", this.restoreSync);
    this.write(ENTER);
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.escTimer);
    if (this.onData) process.stdin.off("data", this.onData);
    if (this.onResize) process.stdout.off("resize", this.onResize);
    process.off("exit", this.restoreSync);
    this.write(this.extraCleanup + LEAVE);
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  /** Last-resort restore if the process exits while the editor is up. */
  private readonly restoreSync = () => {
    if (!this.active) return;
    this.active = false;
    try {
      writeSync(1, this.extraCleanup + LEAVE);
      process.stdin.setRawMode(false);
    } catch {
      /* nothing more we can do */
    }
  };
}
