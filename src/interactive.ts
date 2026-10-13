import { styleText } from "node:util";
import type { RawOptions } from "./options.ts";
import { detectImageProtocol } from "./preview.ts";
import { App } from "./tui/app.ts";
import { designFromRaw } from "./tui/design.ts";
import { Terminal } from "./tui/terminal.ts";

/** Full-screen editor. Resolves when the user quits; prints what was saved. */
export async function runInteractive(initialUrl: string | undefined, defaults: RawOptions, output: string): Promise<void> {
  const term = new Terminal();
  const { design, error } = designFromRaw(initialUrl, defaults);

  let app: App | undefined;
  await new Promise<void>((resolve, reject) => {
    const fail = (err: unknown) => {
      term.stop();
      reject(err);
    };
    app = new App(
      {
        columns: term.columns,
        rows: term.rows,
        write: (data) => term.write(data),
        env: process.env,
        cwd: process.cwd(),
        exit: () => {
          term.stop();
          resolve();
        },
      },
      design,
      output,
    );
    const current = app;
    term.start(
      (e) => {
        try {
          current.handle(e);
        } catch (err) {
          fail(err);
        }
      },
      () => current.resize(term.columns, term.rows),
      detectImageProtocol() === "kitty" ? App.cleanup : "",
    );
    if (error) current.flash(`✖ ${error}`, "error");
    current.start();
  });

  const done = app!;
  if (done.saved.length) {
    for (const path of done.saved) process.stderr.write(`${styleText("green", "✔")} Saved ${styleText("bold", path)}\n`);
  } else process.stderr.write(`${styleText("dim", "Nothing saved.")}\n`);
  if (done.design.url) process.stderr.write(`${styleText("dim", "Re-create it with:")} ${styleText("cyan", done.command)}\n`);
}
