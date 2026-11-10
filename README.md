# canvas-text

GPU-rendered (WebGL2/WebGPU) text display for console logs, terminal output, and plain text. No CodeMirror dependency.

## Pick your backend at import time

There are three entry points. Each one bundles only what it uses, so
choosing WebGL2 is not a runtime flag that ships WebGPU's code and
throws it away at startup — the other backend is not in the file at all.

```js
// Both backends: WebGPU when the browser has it, WebGL2 otherwise.
// Use this when you want a fallback.
import {CanvasText} from "canvas-text"

// Only WebGL2. Works everywhere, including browsers without WebGPU.
import {CanvasText} from "canvas-text/webgl2"

// Only WebGPU. Smallest for a browser you already know supports it.
import {CanvasText} from "canvas-text/webgpu"
```

The two single-backend entries ignore the `backend` option and throw if
their backend is unavailable. The combined one reads it:

| `backend`          | Behaviour                                                  |
| ------------------ | ---------------------------------------------------------- |
| `"auto"` (default) | WebGPU if the browser has one, otherwise WebGL2            |
| `"webgl2"`         | WebGL2 only; throws rather than silently picking the other |
| `"webgpu"`         | WebGPU only; throws rather than silently picking the other |

`view.backend.kind` tells you what you actually got, which matters in
the `"auto"` case.

Sizes, from `bun run build` (minified, gzip):

| Entry                | minified | gzip    | saved vs combined |
| -------------------- | -------- | ------- | ----------------- |
| `canvas-text`        | 43.6 KB  | 14.4 KB | —                 |
| `canvas-text/webgl2` | 34.4 KB  | 11.7 KB | 9.3 KB (21%)      |
| `canvas-text/webgpu` | 36.6 KB  | 12.3 KB | 7.0 KB (16%)      |

`bun run build` writes `dist/canvas-text{,.webgl2,.webgpu}.js` — plain
ESM with named exports, usable straight from a `<script type="module">`
or a CDN without a bundler — plus `.min.js`, `.min.js.map` and
`.min.js.gz` variants. [`demo/dist.html`](demo/dist.html) loads one of
them (`?entry=both|webgl2|webgpu`), which is how the built output is
tested.

## Usage

```js
import {CanvasText, packRGBA} from "canvas-text"

const view = new CanvasText({
  canvas: document.getElementById("c"),
  font: "Consolas, monospace",
  size: 14,
  background: packRGBA(30, 30, 30),
  backend: "auto" // or "webgl2" / "webgpu" to require one
})

await view.init()
view.setText("hello \x1b[32mworld\x1b[0m")
view.start()
```

## Features

- **GPU text rendering** — glyphs and rects drawn with instanced WebGL2/WebGPU draws, no DOM for text
- **Choose your backend at import** — both with fallback, WebGL2 only, or WebGPU only, tree-shaken per entry
- **ANSI colors** — 16/256/24-bit colors, bold, italic, underline, strike
- **Owns its scrolling** — Android OverScroller fling physics; every frame on screen is fully drawn, no blank areas during fast flings even on slow Android WebViews
- **Flywheel** — repeated flicks add up, like Android's list views
- **Monospace cell grid** — integer device-pixel cell width, fractional line height
- **Mouse selection and copy** — drag to select, the view tells you what the range holds
- **Click hit testing** — `onClick` reports the line, column and full text under a click

## Selection and copy

A drag with the mouse selects a range. Touch drags scroll, so the two
never fight. The selection is drawn as a background rect per row, and
the range is exposed as plain text with ANSI escapes removed and tabs
expanded, so visual columns are string indices.

```js
view.getSelection()    // {startLine, startCol, endLine, endCol} | null
view.getSelectedText() // the text in the range, "" when nothing is selected
await view.copySelection()
view.clearSelection()
```

Double-click selects a word, triple-click selects the whole line.

Because the copy path reads the document lines rather than the pixels,
a line wider than the canvas (no wrapping) still copies in full. The
demo fixture exercises this: it logs plain lines, error lines with a
~700-column JSON body, and one 1137-column JSON dump, so the screen clips
them while the clipboard returns them whole.

How this was debugged and fixed, with the measurements: [docs/selection-fix.md](docs/selection-fix.md).

## Click to line and column

The text is drawn by the GPU, so there is no DOM node per line to attach
a listener to. The view converts a pointer position into *text*
coordinates instead — that is the hook a side panel, a tooltip or a
console log needs.

Pass `onClick` and you are told where the click landed. You get the
0-based line and column under the pointer plus the whole line's text,
with ANSI escapes removed and tabs expanded:

```js
const view = new CanvasText({
  canvas: document.getElementById("c"),
  onClick({line, col, text, count}) {
    console.log(`click line ${line}, col ${col} (${text.length} chars, click ×${count})`)
    console.log(text)   // the entire line, not just the visible part
  }
})

await view.init()
view.setText(await fetch("/api/logs").then(r => r.text()))
view.start()
```

Clicking an error line in the demo prints its whole JSON payload to the
console, even though only the first 148 of its 1137 columns are on
screen (long values abbreviated here):

```
click line 4, col 37 (1137 chars, click ×1)
{"event":"batch_rejected","batch":"daa66d13-…","items":[{"sku":"SKU-1000",…}],"audit":"2f740f73-…"}
```

That is the whole point of the feature: a click gives you enough to look
the record up and show it properly. `count` is `1`, `2` or `3` for a
single, double or triple click, and `onClick` runs *before* the click is
resolved into a word or line selection, so `col` is the position you
actually clicked.

For gestures of your own — right click, hover, anything the view does not
own — convert a position yourself:

```js
canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault()
  const {line, col} = view.posAt(e.clientX, e.clientY)
  openPanel(JSON.parse(view.getLine(line)))   // or however you render it
})
```

| API                            | Returns                                            |
| ------------------------------ | -------------------------------------------------- |
| `view.posAt(clientX, clientY)` | `{line, col}` under a viewport position            |
| `view.getLine(line)`           | that line's text, ANSI-free                        |
| `view.getSelection()`          | `{startLine, startCol, endLine, endCol}` or `null` |
| `view.getSelectedText()`       | the text in the selection                          |

Both coordinates are clamped: past the end of a line `col` is the line's
length, and below the last line `line` is the last line, so a position
always maps onto real text.

Clicks are **mouse** clicks — a touch drag scrolls instead, because that
is what a finger on a log is expected to do.

## Which backend is faster?

`bun run bench` renders the same text on the same canvas with both
backends and reports where the time goes. It drives a real Chrome over
the DevTools protocol, so the numbers are real frames, not a simulation.

```sh
bun run bench                 # 300 frames per backend
bun run bench --cpu=4         # throttle, to model a slow device
bun run bench --json          # machine readable
bun run bench --headed        # watch it run
```

Measured on an AMD Radeon 610M through Chrome/ANGLE, 2048 lines, 8522
glyphs per frame:

```
  backend   build    submit   frame μ   frame p95  empty    draw     cold
  webgl2    0.18     0.24     0.21      0.30       0.00     0.21     26.5
  webgpu    0.18     0.24     3.12      4.30       2.99     0.13     9.5
```

Read the columns together, because the headline comparison is
misleading on its own:

- **build** — `scene.build()` alone, writing instances. Shared code,
  identical on both.
- **submit** — a whole `render()` on the main thread, without waiting
  for the GPU. Also identical: the CPU cost of a frame does not depend
  on the backend.
- **frame** — `render()` plus a GPU completion fence. This is the one
  that looks bad for WebGPU.
- **empty** — the same submit-and-fence path with *nothing to draw*. On
  this machine WebGPU pays ~3 ms here and WebGL2 pays ~0, which is where
  the whole difference comes from.
- **draw** — `frame - empty`, the part the text actually costs. WebGPU
  is slightly *cheaper* (0.13 vs 0.21 ms).
- **cold** — a fresh view on a new canvas: init, `setText`, first frame.
  Noisy: pipeline compilation dominates, and it flipped between runs on
  this same machine (9.5 ms for WebGPU vs 26.5 for WebGL2 unthrottled,
  41.5 vs 33.6 at `--cpu=4`). Do not pick a backend on this column.

Under `--cpu=4` the same run gives WebGL2 `submit` 0.90 ms and WebGPU
1.05 ms, while WebGPU's `empty` grows from 2.99 to 4.20 ms. The fixed
cost scales with CPU throttling, so it is Dawn's submit path on the
thread, not the GPU rasterising glyphs.

So the honest conclusion for this machine is not "WebGPU is 15x slower".
It is: **the two backends draw this workload at the same cost, and the
CPU side of a frame is nearly identical; on this driver Dawn's
per-submit path costs ~3 ms, while ANGLE's costs ~0.** That cost is
fixed per frame, so it only matters if you submit many small frames — in
a `requestAnimationFrame` loop both fit in a 16.7 ms budget. On a driver
where submit is cheap the same benchmark will show different numbers.

That is exactly why the benchmark measures `empty` and `submit`
separately: run it on your own hardware and read your own numbers
instead of trusting this table.

## Development

```sh
bun install
bun run check   # TypeScript (tsc --noEmit)
bun run build   # three bundles + size report
bun run demo    # static server at http://127.0.0.1:3001 (Bun built-in)
bun run bench   # WebGL2 vs WebGPU on this machine
```

Demo URL params: `?backend=auto|webgl2|webgpu`, `?lines=N`.
[`demo/dist.html`](demo/dist.html) takes `?entry=both|webgl2|webgpu` and
loads the built bundles rather than the source.

## Architecture

```
  src/
    index.js            both backends (default entry)
    api.js              exports shared by every entry, backend-free
    view.js             CanvasText: state, geometry, frame loop
    color.js            CSS color → packed 0xAABBGGRR
    metrics.js          font measurement → cell and line sizes
    atlas.js            glyph atlas: per-font-variant coverage masks, shelf packing
    instances.js        growable instance buffers
    scene.js            per-line glyph/rect instance builder
    ansi.js             ANSI escape sequences → styled runs
    spline.js           Android OverScroller spline + velocity tracker
    scroll.js           touch drag, fling, wheel, flywheel
    webgl2.js           WebGL2 backend
    webgpu.js           WebGPU backend
    entries/
      auto.js           CanvasText + both backends, WebGPU preferred
      webgl2.js         CanvasText + WebGL2 only
      webgpu.js         CanvasText + WebGPU only
  bench/perf.mjs        backend comparison, driven through Chrome
  demo/dist.html        smoke test for the built bundles
```

`view.js` never imports a backend. It calls `this.createBackend()`,
which the entry's `CanvasText` subclass implements — that indirection is
what lets a single-backend bundle drop the other backend's code.
