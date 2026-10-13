import QRCode from "qrcode";
import { getPositions } from "qrcode/lib/core/alignment-pattern.js";
import type { ErrorLevel } from "./options.ts";

export interface Matrix {
  /** Modules per side. */
  size: number;
  version: number;
  /** Centre (row, col) of each 5×5 alignment pattern. */
  alignmentCenters: [number, number][];
  isDark(row: number, col: number): boolean;
}

export function buildMatrix(data: string, ecl: ErrorLevel): Matrix {
  const qr = QRCode.create(data, { errorCorrectionLevel: ecl });
  const { size, data: bits } = qr.modules;
  return {
    size,
    version: qr.version,
    alignmentCenters: getPositions(qr.version),
    isDark: (row, col) => row >= 0 && col >= 0 && row < size && col < size && bits[row * size + col] === 1,
  };
}

/** Top-left corner (row, col) of each 7×7 finder pattern ("eye"). */
export function finderOrigins(size: number): [number, number][] {
  return [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ];
}

export function isFinder(row: number, col: number, size: number): boolean {
  return finderOrigins(size).some(([r, c]) => row >= r && row < r + 7 && col >= c && col < c + 7);
}

export function isAlignment(row: number, col: number, centers: [number, number][]): boolean {
  return centers.some(([r, c]) => Math.abs(row - r) <= 2 && Math.abs(col - c) <= 2);
}
