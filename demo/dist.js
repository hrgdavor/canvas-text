// Loads one of the built bundles, so the dist output is tested rather
// than assumed. ?entry=both|webgl2|webgpu  ?backend=auto|webgl2|webgpu
const params = new URLSearchParams(location.search)
const entry = params.get("entry") ?? "both"
const info = document.getElementById("info")
const url = entry === "both" ? "../dist/canvas-text.js" : `../dist/canvas-text.${entry}.js`
info.textContent = `loading ${url} …`

const TEXT = [
	"\x1b[1;36m$ node server.js\x1b[0m",
	"\x1b[32m✓\x1b[0m Listening on \x1b[1;33mhttp://localhost:3001\x1b[0m",
	"",
	"\x1b[2m00:00:01\x1b[0m \x1b[1;32mINFO\x1b[0m \x1b[36mapi\x1b[0m  request handled in 100ms",
	"\x1b[2m00:00:02\x1b[0m \x1b[1;31mERROR\x1b[0m \x1b[36mcache\x1b[0m  {\"id\":\"req_3c6ef362\",\"status\":503,\"upstream\":{\"name\":\"auth\",\"circuit\":\"half-open\"}}",
	"\x1b[2m00:00:03\x1b[0m \x1b[1;33mWARN\x1b[0m \x1b[36mworker\x1b[0m  \x1b[4mretrying\x1b[0m in 400ms",
	"",
	"\x1b[32m✓\x1b[0m All services healthy"
].join("\n")

try {
	const mod = await import(url)
	const canvas = document.getElementById("canvas")
	const view = new mod.CanvasText({
		canvas,
		size: 14,
		background: mod.packRGBA(30, 30, 30),
		backend: params.get("backend") ?? "auto"
	})
	await view.init()
	view.setText(TEXT)
	view.start()
	info.textContent = `${entry} bundle | ${view.backend.kind} | ${view._plain.length} lines | ${Object.keys(mod).length} exports`
	window.view = view
	window.__ready = true
} catch (err) {
	info.textContent = `${entry} bundle failed: ${err.message}`
	console.error(err)
}
