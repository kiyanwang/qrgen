#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { styleText } from "node:util";
import { Command, Option } from "commander";
import { generate, save } from "./generate.ts";
import { runInteractive } from "./interactive.ts";
import {
  DEFAULTS,
  ERROR_LEVELS,
  EYE_STYLES,
  GRADIENT_TYPES,
  MODULE_STYLES,
  resolveOptions,
  type RawOptions,
} from "./options.ts";
import { livePreview } from "./preview.ts";

interface CliOptions extends RawOptions {
  output: string;
  preview?: boolean;
  interactive?: boolean;
  quiet?: boolean;
}

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const program = new Command()
  .name("qrgen")
  .description("Generate a customisable QR code PNG for a URL.")
  .version(version)
  .argument("[url]", "URL to encode (bare hosts get https://). Omit to open the editor, or pipe it on stdin.")
  .option("-o, --output <file>", 'output PNG path, or "-" for stdout', "qrcode.png")
  .option("-s, --size <px>", "image width and height in pixels", String(DEFAULTS.size))
  .option("-m, --margin <modules>", "quiet zone around the code, in modules", String(DEFAULTS.margin))
  .option("--fg <colour>", "foreground colour (any CSS colour)", DEFAULTS.fg)
  .option("--bg <colour>", 'background colour, or "transparent"', DEFAULTS.bg)
  .option("-g, --gradient <from,to>", 'gradient foreground, e.g. "#ff0080,#7928ca" (overrides --fg)')
  .addOption(new Option("--gradient-type <type>", "gradient shape").choices(GRADIENT_TYPES).default(DEFAULTS.gradientType))
  .option("--gradient-angle <deg>", "linear gradient direction (0 = left→right, 90 = top→bottom)", String(DEFAULTS.gradientAngle))
  .addOption(new Option("--style <style>", "module shape").choices(MODULE_STYLES).default(DEFAULTS.style))
  .addOption(new Option("--eye-style <style>", "corner finder pattern shape").choices(EYE_STYLES).default(DEFAULTS.eyeStyle))
  .option("--eye-color <colour>", "corner finder pattern colour (defaults to foreground)")
  .option("--logo <file>", "image to place in the centre (PNG, JPEG, SVG…)")
  .option("--logo-size <fraction>", "logo width as a fraction of the code, 0.05–0.3", String(DEFAULTS.logoSize))
  .addOption(
    new Option("-e, --ecl <level>", `error correction: L 7%, M 15%, Q 25%, H 30% (default ${DEFAULTS.ecl}, or H with --logo)`)
      .choices(ERROR_LEVELS),
  )
  .option("--raw", "encode the input exactly as given, without URL checks")
  .option("-p, --preview", "also print the code in the terminal")
  .option("-i, --interactive", "open the full-screen editor (other options pre-fill it)")
  .option("-q, --quiet", "only print errors")
  .addHelpText(
    "after",
    `
Examples:
  $ qrgen example.com
  $ qrgen https://example.com -o site.png --fg "#1e3a8a" --style dots --eye-style circle
  $ qrgen example.com -g "#ff0080,#7928ca" --style rounded --eye-style rounded --eye-color "#111"
  $ qrgen example.com --logo logo.png --bg transparent -s 2048
  $ echo "https://example.com" | qrgen -o - > code.png
  $ qrgen                      # full-screen editor
  $ qrgen -i example.com --style dots`,
  )
  .action(async (url: string | undefined, opts: CliOptions) => {
    const interactiveTerminal = process.stdin.isTTY && process.stderr.isTTY;
    if (opts.interactive || (url === undefined && interactiveTerminal)) {
      if (!interactiveTerminal) throw new Error("Interactive mode needs a terminal");
      await runInteractive(url, opts, opts.output);
      return;
    }

    const input = url ?? (await readStdin());
    const { options, warnings } = resolveOptions(input, opts);
    const log = (msg: string) => !opts.quiet && process.stderr.write(`${msg}\n`);
    for (const w of warnings) log(styleText("yellow", `⚠ ${w}`));

    const result = await generate(options);
    await save(result.png, opts.output);

    if (opts.preview) {
      // Without inline images, fall back to whole modules so the preview still scans.
      const preview = await livePreview(options, { fallback: "modules", columns: process.stderr.columns, rows: process.stderr.rows });
      process.stderr.write(`${preview}\n`);
    }
    if (opts.output !== "-") {
      log(
        `${styleText("green", "✔")} Saved ${styleText("bold", opts.output)} ` +
          styleText("dim", `(${options.size}×${options.size}px, version ${result.version}, ECL ${options.ecl}) → ${options.data}`),
      );
    }
  });

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error("No URL given");
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (!text.trim()) throw new Error("No URL given (stdin was empty)");
  return text;
}

program.parseAsync().catch((err: unknown) => {
  process.stderr.write(`${styleText("red", "✖")} ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
