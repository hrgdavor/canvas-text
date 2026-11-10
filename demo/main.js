import {CanvasText, packRGBA} from "../src/index.js"

const canvas = document.getElementById("canvas")
const info = document.getElementById("info")
const copyBtn = document.getElementById("copy")

const SERVICES = ["api", "worker", "cache", "db", "auth", "queue"]
const LEVELS = [
	"\x1b[1;32mINFO\x1b[0m",
	"\x1b[1;33mWARN\x1b[0m",
	"\x1b[1;31mERROR\x1b[0m",
	"\x1b[1;35mDEBUG\x1b[0m"
]
const MESSAGES = [
	"request handled in {n}ms",
	"cache hit ratio {n}%",
	"connection pool at {n}/50",
	"gc pause {n}ms",
	"retrying in {n}ms",
	"flushed {n} rows",
	"token refreshed",
	"heartbeat ok",
	"compaction done ({n}ms)",
	"slow query: {n}ms"
]
// ERROR sits at index 2, so every fourth line carries a payload.
const ERROR_LEVEL = 2

/**
 * Deterministic pseudo-hex id.
 * @param {number} n
 * @returns {string}
 */
function hex(n) {
	return ((n * 2654435761) >>> 0).toString(16).padStart(8, "0")
}

/**
 * @param {number} n
 * @returns {string}
 */
function traceId(n) {
	return `${hex(n)}-${hex(n + 7).slice(0, 4)}-4${hex(n + 13).slice(0, 3)}-a${hex(n + 29).slice(0, 3)}-${hex(n + 31)}${hex(n + 37).slice(0, 4)}`
}

/**
 * A single-line JSON payload, the kind a service dumps after an error.
 * It is deliberately one line and ~700 columns wide: wider than any
 * window, so the screen clips it and the clipboard must not.
 * @param {number} i
 * @returns {string}
 */
function jsonPayload(i) {
	return `{"id":"req_${hex(i)}","trace":"${traceId(i)}","service":"${SERVICES[i % SERVICES.length]}","status":503,"latency_ms":${120 + (i * 3) % 800},"retry":{"attempt":${1 + i % 4},"backoff_ms":${200 * (1 + i % 5)},"deadline_ms":5000},"request":{"method":"POST","path":"/v1/sessions/refresh","headers":{"content-type":"application/json","x-request-id":"${traceId(i + 1)}","user-agent":"node-fetch/3.3.2 (linux x64)"},"body":{"grant_type":"refresh_token","client_id":"svc-${i % 7}","scope":"read write admin"}},"context":{"node":"api-${i % 5}","region":"eu-central-1","queue":"default","pool":{"size":50,"in_use":${14 + i % 30},"waiting":${i % 7}},"upstream":{"name":"auth","circuit":"half-open","timeout_ms":${900 + i % 400}}}}`
}

/**
 * One very wide line for the top of the log, so clipping can be compared
 * against copying without scrolling to find a payload.
 * @returns {string}
 */
function wideJson() {
	let items = []
	for (let k = 0; k < 12; k++) {
		items.push(`{"sku":"SKU-${1000 + k}","qty":${1 + k},"reason":"price_mismatch","expected":${900 + k * 7},"actual":${905 + k * 3}}`)
	}
	return `{"event":"batch_rejected","batch":"${traceId(3)}","items":[${items.join(",")}],"audit":"${traceId(99)}"}`
}

// Generate a large console log with ANSI escape sequences so the
// fling physics can be demonstrated.
function generateLog(n) {
	const lines = []
	lines.push("\x1b[1;36m$ node server.js\x1b[0m")
	lines.push("\x1b[32m✓\x1b[0m Listening on \x1b[1;33mhttp://localhost:3001\x1b[0m")
	lines.push("\x1b[2m# JSON payloads run past the right edge; shift+wheel scrolls, triple-click copies a whole line\x1b[0m")
	lines.push("")
	lines.push(`\x1b[1;31mERROR\x1b[0m \x1b[36mpayments\x1b[0m  batch rejected  ${wideJson()}`)
	lines.push("")
	for (let i = 0; i < n; i++) {
		let tag = LEVELS[i % LEVELS.length]
		let msg = MESSAGES[i % MESSAGES.length].replace("{n}", String(100 + (i * 7) % 900))
		let ts = `00:${String(Math.floor(i / 60) % 60).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`
		let svc = SERVICES[i % SERVICES.length]
		let line = `\x1b[2m${ts}\x1b[0m ${tag} \x1b[36m${svc}\x1b[0m  ${msg}`
		// Errors carry a JSON body, so roughly one line in four is wide.
		if (i % LEVELS.length === ERROR_LEVEL) line += `  ${jsonPayload(i)}`
		lines.push(line)
		if (i % 50 === 49) lines.push("")
	}
	lines.push("")
	lines.push("\x1b[1;32m✓\x1b[0m All services healthy")
	return lines.join("\n")
}

// ?backend=auto|webgl2|webgpu   ?lines=N
const params = new URLSearchParams(location.search)
const backendKind = /** @type {"auto"|"webgl2"|"webgpu"} */ (params.get("backend") ?? "auto")
const lineCount = Math.max(1, Number(params.get("lines")) || 500)

const demoText = generateLog(lineCount)

const view = new CanvasText({
	canvas,
	font: "Consolas, 'Cascadia Code', 'Fira Code', monospace",
	size: 14,
	background: packRGBA(30, 30, 30),
	backend: backendKind,
	scrollSpeed: 1,
	// A click tells you which line it landed on. Here it is logged to
	// the console; a real host would open the error's JSON in a panel
	// next to the log. The full line is reported even when the screen
	// only shows its first few columns.
	onClick({line, col, text, count}) {
		console.log(`click line ${line}, col ${col} (${text.length} chars, click ×${count})`)
		console.log(text)
	}
})

view.init().then(() => {
	view.setText(demoText)
	view.start()
	let widest = 0
	for (let line of view._plain) widest = Math.max(widest, line.length)
	let visible = Math.floor(view.width / view.metrics.cellWidth)
	info.textContent = `canvas-text | ${view.backend.kind} | ${view._lines.length} lines | widest line ${widest} cols, ${visible} visible | drag selects, triple-click a line, shift+wheel sideways, Ctrl+C copies`
	// The perf test (bench/perf.mjs) waits for this.
	window.__ready = true
}).catch((err) => {
	info.textContent = `canvas-text | ${backendKind} unavailable: ${err.message}`
	console.error(err)
})

// Copy button. The selection is in visual columns; the library maps it
// back to text, so lines wider than the viewport still copy in full.
copyBtn.addEventListener("click", () => {
	let text = view.getSelectedText()
	view.copySelection().then(() => {
		let widest = 0
		for (let line of text.split("\n")) widest = Math.max(widest, line.length)
		copyBtn.textContent = text ? `Copied ${text.length} chars, widest ${widest}` : "Nothing selected"
		setTimeout(() => { copyBtn.textContent = "Copy" }, 2000)
	}).catch(() => {
		copyBtn.textContent = "Copy failed"
		setTimeout(() => { copyBtn.textContent = "Copy" }, 1200)
	})
})

// Ctrl+C to copy selection, Escape to clear it.
window.addEventListener("keydown", (e) => {
	if (e.ctrlKey && e.key === "c") {
		e.preventDefault()
		view.copySelection()
	} else if (e.key === "Escape") {
		view.clearSelection()
	}
})

// Handle resize
window.addEventListener("resize", () => view.resize())

// Expose for debugging and for bench/perf.mjs (which builds a second view
// to measure cold start).
window.view = view
window.CanvasText = CanvasText
