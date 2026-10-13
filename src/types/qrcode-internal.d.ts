declare module "qrcode/lib/core/alignment-pattern.js" {
  /** Centre (row, col) of every alignment pattern for a QR version. */
  export function getPositions(version: number): [number, number][];
}
