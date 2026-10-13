import type { KeyEvent, MouseEvent } from "../input.ts";
import type { Rect, Screen } from "../screen.ts";

/** A modal popup. The app draws its frame and background; the dialog draws inside. */
export interface Dialog {
  readonly title: string;
  /** Preferred outer size, given the space available. */
  size(maxW: number, maxH: number): { w: number; h: number };
  render(s: Screen, inner: Rect): void;
  key(e: KeyEvent): void;
  /** Mouse events in absolute screen cells (dialogs remember where they were drawn). */
  mouse?(e: MouseEvent): void;
  paste?(text: string): void;
  /** Key hints for the status bar. */
  hints(): string;
}
