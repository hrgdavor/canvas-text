// Compares the WebGL2 and WebGPU backends on the same machine, the same
// text and the same canvas, by driving a real browser over the DevTools
// protocol. Run it from the project root:
//
//   bun bench/perf.mjs
//   bun bench/perf.mjs --cpu=4          # throttle, like a slow phone
//   bun bench/perf.mjs --frames=600 --lines=4000
//   bun bench/perf.mjs --json           # machine readable
//
// The numbers are milliseconds per frame, measured three ways:
//
//   build   scene.build() alone: instanced glyph/rect writing, pure CPU
//   submit  a whole view.render(): build + upload + submit, no GPU wait
//   frame   render plus a GPU completion fence, so the GPU is included
//
// "submit" is what a frame costs the main thread; "frame" is what it
// costs wall-clock once the GPU has actually finished. A backend with
// cheap submit but expensive frame is queueing work it cannot keep up
// with.

import {spawn} from "node:child_process"
import {existsSync} from "node:fs"
import {fileURLToPath} from "node:url"

const args = process.argv.slice(2)
/** @param {string} name @param {string} fallback */
const flag = (name, fallback) => {
	let hit = args.find(a => a.startsWith(`--${name}=`))
	return hit ? hit.slice(name.length + 3) : fallback
}
const has = (name) => args.includes(`--${name}`)

const FRAMES = Number(flag("frames", "300"))
const LINES = Number(flag("lines", "2000"))
const CPU_THROTTLE = Number(flag("cpu", "1"))
const PORT = Number(flag("port", "3011"))
const DEBUG_PORT = Number(flag("debug-port", "9450"))
const JSON_OUT = has("json")
const HEADED = has("headed")

const CANDIDATES = [
	process.env.CHROME_PATH,
	flag("browser", ""),
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium"
].filter(Boolean)

const chromePath = CANDIDATES.find(p => existsSync(p))
if (!chromePath) {
	console.error("No Chrome/Edge found. Pass --browser=<path> or set CHROME_PATH.")
	process.exit(1)
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/** @param {string} url */
async function waitFor(url, timeoutMs = 15000) {
	let end = Date.now() + timeoutMs
	while (Date.now() < end) {
		try {
			let r = await fetch(url)
			if (r.ok) return true
		} catch {}
		await sleep(100)
	}
	return false
}

// ---- page-side benchmark -------------------------------------------------
// Runs inside the browser. Everything it needs is on `window`.
const PAGE_BENCH = `async (frames) => {
	const v = window.view
	const kind = v.backend.kind
	const sync = kind === "webgpu"
		? () => v.backend.device.queue.onSubmittedWorkDone()
		: () => { v.backend.gl.finish(); return Promise.resolve() }
	const rows = Math.ceil(v.height / v.metrics.lineHeight) + 1
	const base = v.scroller.scrollTop
	// Vary the scroll position so each frame builds different rows.
	const scroll = (i) => { v.scroller.scrollTop = base + (i * 7) % 400 }

	for (let i = 0; i < 25; i++) v.render()
	await sync()

	let t0 = performance.now()
	for (let i = 0; i < frames; i++) { scroll(i); v.render() }
	const submit = (performance.now() - t0) / frames

	// Instanced glyph/rect writing on its own: shared by both backends,
	// so it is the floor neither can go below.
	t0 = performance.now()
	for (let i = 0; i < frames; i++) v.scene.build(0, rows, null, v.selectionColor)
	const build = (performance.now() - t0) / frames

	let times = []
	for (let i = 0; i < frames; i++) {
		scroll(i)
		let a = performance.now()
		v.render()
		await sync()
		times.push(performance.now() - a)
	}
	times.sort((a, b) => a - b)
	const mean = times.reduce((s, t) => s + t, 0) / times.length
	const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]

	// The fence itself costs something, and that cost is part of every
	// "frame" number. Measure it with nothing new submitted, so it can be
	// read as a floor rather than silently inflating one backend.
	v.render()
	await sync()
	let f0 = performance.now()
	for (let i = 0; i < 50; i++) await sync()
	const fenceIdle = (performance.now() - f0) / 50

	// Fixed per-frame cost of going through the backend at all: the same
	// submit + fence path with nothing to draw. Whatever this is, every
	// frame pays it, and it says whether a slow frame is the content or
	// the driver (Dawn's D3D11 submit is expensive on some machines).
	for (let i = 0; i < 20; i++) { v.backend.render(v.background, []); await sync() }
	let e0 = performance.now()
	for (let i = 0; i < frames; i++) { v.backend.render(v.background, []); await sync() }
	const empty = (performance.now() - e0) / frames

	// A second view on a fresh canvas: init, setText and the first frame
	// rasterise the visible glyphs, which is a real startup cost.
	const c = document.createElement("canvas")
	c.style.cssText = "position:fixed;left:-9999px;top:0;width:1200px;height:800px"
	document.body.appendChild(c)
	let cold = -1
	try {
		const t1 = performance.now()
		const fresh = new window.CanvasText({canvas: c, backend: v.backendKind})
		await fresh.init()
		fresh.setText(v._lines.join("\\n"))
		fresh.render()
		cold = performance.now() - t1
		fresh.destroy()
	} catch (e) {
		cold = -1
	}
	c.remove()

	let renderer = ""
	try {
		const gl = document.createElement("canvas").getContext("webgl2")
		const dbg = gl && gl.getExtension("WEBGL_debug_renderer_info")
		renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : "unknown renderer"
	} catch {
		renderer = "unknown renderer"
	}

	v.scroller.scrollTop = base
	return {kind, frames, submit, frameMean: mean, frameP95: p95, fenceIdle, empty, build, cold, glyphs: v.glyphBuf.count, renderer}
}`

// ---- main ----------------------------------------------------------------

const projectRoot = fileURLToPath(new URL("..", import.meta.url))
const server = spawn("bun", ["serve.mjs"], {
	cwd: projectRoot,
	env: {...process.env, PORT: String(PORT)},
	stdio: ["ignore", "pipe", "pipe"]
})
server.stdout.on("data", () => {})
server.stderr.on("data", () => {})

const profile = `${process.env.TEMP || "/tmp"}/canvas-text-bench-${process.pid}`
const chromeArgs = [
	`--remote-debugging-port=${DEBUG_PORT}`,
	`--user-data-dir=${profile}`,
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-extensions",
	"--window-size=1200,800",
	"--enable-unsafe-swiftshader",
	"about:blank"
]
if (!HEADED) chromeArgs.unshift("--headless=new")

const chrome = spawn(chromePath, chromeArgs, {stdio: "ignore"})

let ws = null
let exitCode = 0

try {
	if (!await waitFor(`http://127.0.0.1:${PORT}/`)) throw new Error(`static server did not start on ${PORT}`)
	if (!await waitFor(`http://127.0.0.1:${DEBUG_PORT}/json/version`)) throw new Error("browser did not start")

	let list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()
	let target = list.find(t => t.type === "page")
	if (!target) throw new Error("no page target")

	ws = new WebSocket(target.webSocketDebuggerUrl)
	let nextId = 1
	const pending = new Map(), listeners = new Map()
	ws.onmessage = (ev) => {
		let m = JSON.parse(ev.data)
		if (m.id && pending.has(m.id)) {
			let {resolve, reject} = pending.get(m.id)
			pending.delete(m.id)
			m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
		} else if (m.method && listeners.has(m.method)) {
			for (let fn of listeners.get(m.method)) fn(m.params)
		}
	}
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })

	const send = (method, params = {}) => new Promise((resolve, reject) => {
		let id = nextId++
		pending.set(id, {resolve, reject})
		ws.send(JSON.stringify({id, method, params}))
	})
	const once = (method) => new Promise(resolve => {
		let list = listeners.get(method) ?? []
		listeners.set(method, list)
		list.push(function fn(p) { list.splice(list.indexOf(fn), 1); resolve(p) })
	})
	const ev = async (expr) => {
		let r = await send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true})
		if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails))
		return r.result.value
	}

	await send("Page.enable")
	await send("Runtime.enable")
	if (CPU_THROTTLE > 1) await send("Emulation.setCPUThrottlingRate", {rate: CPU_THROTTLE})

	const results = []
	for (let kind of ["webgl2", "webgpu"]) {
		let loaded = once("Page.loadEventFired")
		await send("Page.navigate", {url: `http://127.0.0.1:${PORT}/?backend=${kind}&lines=${LINES}`})
		await loaded
		let ready = false
		for (let i = 0; i < 100 && !ready; i++) {
			ready = await ev(`!!window.__ready`)
			if (!ready) await sleep(100)
		}
		if (!ready) {
			results.push({kind, error: await ev(`document.getElementById("info").textContent || "not ready"`)})
			continue
		}
		let env = await ev(`({
			ua: navigator.userAgent.replace(/^.*?(Chrome\\/[\\d.]+).*$/, "$1"),
			hasWebGPU: !!navigator.gpu,
			dpr: window.devicePixelRatio,
			width: window.view.width,
			height: window.view.height,
			backend: window.view.backend.kind,
			lines: window.view._lines.length
		})`)
		let bench = await send("Runtime.evaluate", {
			expression: `(${PAGE_BENCH})(${FRAMES})`,
			returnByValue: true,
			awaitPromise: true
		})
		if (bench.exceptionDetails) throw new Error(bench.exceptionDetails.exception?.description ?? "bench failed")
		results.push({...env, ...bench.result.value})
	}

	const env0 = results.find(r => !r.error)
	if (!JSON_OUT) {
		console.log("")
		console.log("canvas-text backend comparison")
		console.log("─────────────────────────────")
		if (env0) {
			console.log(`  ${env0.ua}   DPR ${env0.dpr}   canvas ${Math.round(env0.width)}x${Math.round(env0.height)}   ${env0.lines} lines`)
			console.log(`  renderer: ${env0.renderer}`)
			if (CPU_THROTTLE > 1) console.log(`  CPU throttled ${CPU_THROTTLE}x`)
		}
		console.log("")
		const pad = (s, n) => String(s).padEnd(n)
		console.log(`  ${pad("backend", 9)} ${pad("build", 8)} ${pad("submit", 8)} ${pad("frame μ", 9)} ${pad("frame p95", 10)} ${pad("empty", 8)} ${pad("draw", 8)} ${pad("cold", 8)}`)
		for (let r of results) {
			if (r.error) {
				console.log(`  ${pad(r.kind, 9)} unavailable: ${String(r.error).slice(0, 70)}`)
				continue
			}
			let draw = Math.max(0, r.frameMean - r.empty)
			console.log(
				`  ${pad(r.kind, 9)} ${pad(r.build.toFixed(2), 8)} ${pad(r.submit.toFixed(2), 8)} ` +
				`${pad(r.frameMean.toFixed(2), 9)} ${pad(r.frameP95.toFixed(2), 10)} ${pad(r.empty.toFixed(2), 8)} ${pad(draw.toFixed(2), 8)} ${pad(r.cold.toFixed(1), 8)}`
			)
		}
		console.log("")
		console.log("  build   scene.build() only, CPU (shared by both backends)")
		console.log("  submit  whole render(), CPU, no GPU wait")
		console.log("  frame   render + GPU fence, wall clock (mean / p95, ms)")
		console.log("  empty   the same submit + fence with nothing to draw: fixed")
		console.log("          per-frame overhead. A frame far above this is the content,")
		console.log("          a frame close to it is the driver.")
		console.log("  draw    frame μ - empty, the part the text actually costs")
		console.log("  cold    new view on a fresh canvas: init, setText, first frame (ms)")
		let gl = results.find(r => r.kind === "webgl2" && !r.error)
		let gpu = results.find(r => r.kind === "webgpu" && !r.error)
		if (gl && gpu) {
			console.log("")
			const pct = (a, b) => `${((b - a) / a * 100 >= 0 ? "+" : "")}${((b - a) / a * 100).toFixed(1)}%`
			console.log(`  webgpu vs webgl2:  submit ${pct(gl.submit, gpu.submit)}   frame ${pct(gl.frameMean, gpu.frameMean)}   cold ${pct(gl.cold, gpu.cold)}`)
			console.log(`  (negative means WebGPU is faster; lower is better)`)
		}
	}

	if (JSON_OUT) console.log(JSON.stringify(results, null, 2))
} catch (err) {
	console.error(`bench failed: ${err.message}`)
	exitCode = 1
} finally {
	try { ws?.close() } catch {}
	try { chrome.kill() } catch {}
	try { server.kill() } catch {}
	await sleep(200)
}

process.exit(exitCode)
