import {join, dirname, extname} from "node:path"
import {fileURLToPath} from "node:url"
import {readFileSync} from "node:fs"

const root = dirname(fileURLToPath(import.meta.url))
const port = process.env.PORT || 3001

const MIME = {
	".html": "text/html",
	".js": "text/javascript",
	".mjs": "text/javascript",
	".css": "text/css",
	".json": "application/json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
	".woff": "font/woff",
	".gz": "application/gzip"
}

Bun.serve({
	port,
	hostname: "127.0.0.1",
	fetch(req) {
		let url = new URL(req.url)
		let path = url.pathname === "/" ? "/index.html" : url.pathname
		// Try demo/ first, then project root.
		let candidates = [join(root, "demo", path), join(root, path)]
		for (let file of candidates) {
			try {
				let data = readFileSync(file)
				let type = MIME[extname(file)] || "application/octet-stream"
				return new Response(data, {headers: {"content-type": type, "cache-control": "no-store"}})
			} catch {}
		}
		return new Response("not found", {status: 404})
	}
})
console.log(`http://127.0.0.1:${port}`)
