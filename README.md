# qrgen

Generate customisable QR code PNGs for a URL, from the command line or an interactive terminal UI.

```sh
npm install
npm link            # puts `qrgen` on your PATH (or run `node src/cli.ts …` directly)
```

Requires Node 22.18+ (TypeScript runs natively; `npm run build` compiles to `dist/` for the linked binary).

## Editor

Run `qrgen` with no URL (or `qrgen -i <url> [options]` to pre-fill it) for a full-screen editor:

- **URL bar** across the top. Tab or click to edit it; the preview follows as you type.
- **Options** down the left. ↑↓ to select, ←→ to change a value in place, Enter to open its popup, ⌫ to reset (eye colour, logo, error correction).
- **Preview** in the middle, updating live, including while a popup is open. It is the real rendered PNG in terminals with inline images (Ghostty, Kitty, WezTerm). Elsewhere it is drawn with coloured half-block characters, which still shows shapes, gradients and logos.
- **Colour picker** popup: a hue/saturation wheel, brightness bar, R/G/B sliders, a field that takes `#hex` or CSS names like `teal`, palette swatches, a new/was swatch and a live contrast check. Everything works with the mouse (click and drag) or keyboard.
- **File browser** for the logo (type to filter, ⌫ goes up a folder, ~ goes home), and list popups that preview each choice as you move.
- **Ctrl-S** saves (asks before overwriting); `q` or Ctrl-C quits and prints the equivalent `qrgen` command so you can script the design.

Inside tmux/screen the inline image is skipped. Set `QRGEN_PREVIEW=kitty` or `text` to override detection.

## Command line

```sh
qrgen example.com                                          # → qrcode.png, https:// added
qrgen https://example.com -o site.png --fg "#1e3a8a" --style dots --eye-style circle
qrgen example.com -g "#ff0080,#7928ca" --style rounded --eye-style rounded --eye-color "#111"
qrgen example.com --logo logo.png --bg transparent -s 2048
qrgen "WIFI:T:WPA;S:MyNet;P:secret;;" --raw                # any text, not just URLs
echo https://example.com | qrgen -o - > code.png           # stdin → stdout
```

| Option | Default | |
| --- | --- | --- |
| `-o, --output <file>` | `qrcode.png` | `-` writes to stdout |
| `-s, --size <px>` | `1024` | 64–8192 |
| `-m, --margin <modules>` | `4` | quiet zone; keep ≥ 2 |
| `--fg <colour>` / `--bg <colour>` | black / white | any CSS colour; `--bg transparent` |
| `-g, --gradient <from,to>` | | overrides `--fg` |
| `--gradient-type` | `linear` | `linear`, `radial` |
| `--gradient-angle <deg>` | `45` | 0 = left→right, 90 = top→bottom |
| `--style` | `square` | `square`, `dots`, `rounded` |
| `--eye-style` | `square` | `square`, `rounded`, `circle` |
| `--eye-color <colour>` | foreground | |
| `--logo <file>` | | PNG/JPEG/SVG, centred; modules beneath are cleared |
| `--logo-size <fraction>` | `0.22` | 0.05–0.3 of the code width |
| `-e, --ecl` | `M` (`H` with a logo) | `L`, `M`, `Q`, `H` |
| `--raw` | | skip URL validation |
| `-p, --preview` | | also print the code in the terminal (real image where supported, otherwise a scannable block version) |
| `-q, --quiet` | | errors only |

qrgen warns (but still writes the file) about choices that commonly fail to scan: contrast under 3:1, inverted colours, small margins, or a logo without high error correction.

## Development

```sh
npm test            # unit tests + every style decoded back with an independent reader (jsQR)
npm run typecheck
QR_SAMPLES_DIR=/tmp/qr npm test   # keep the rendered test images for a look
```
