import { writeFile } from "node:fs/promises";
import { buildMatrix } from "./matrix.ts";
import type { QrOptions } from "./options.ts";
import { renderPng } from "./render.ts";

export interface Generated {
  png: Buffer;
  /** QR version (1–40) — a rough measure of density. */
  version: number;
  modules: number;
}

export async function generate(options: QrOptions): Promise<Generated> {
  const { version, size } = buildMatrix(options.data, options.ecl);
  return { png: await renderPng(options), version, modules: size };
}

/** Write to a file, or to stdout when the path is "-". */
export async function save(png: Buffer, output: string): Promise<void> {
  if (output === "-") {
    if (process.stdout.isTTY) throw new Error("Refusing to write binary PNG data to a terminal; pipe it or use -o <file>");
    await new Promise<void>((resolve, reject) => process.stdout.write(png, (err) => (err ? reject(err) : resolve())));
    return;
  }
  await writeFile(output, png);
}
