import {execSync} from "node:child_process"
import {writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, readdirSync, copyFileSync} from "node:fs"
import {gzipSync} from "node:zlib"
import {join, dirname} from "node:path"
import {fileURLToPath} from "node:url"

const root = dirname(fileURLToPath(import.meta.url))
const dist = join(root, "dist")
const tmp = join(dist, ".tmp")

// One build per entry point. Each entry imports only the backend it
// needs, so the webgl2 build contains no WebGPU code and the webgpu
// build contains no WebGL2 code.
const ENTRIES = [
	{name: "canvas-text", entry: "src/index.js", what: "WebGL2 + WebGPU, WebGPU preferred"},
	{name: "canvas-text.webgl2", entry: "src/entries/webgl2.js", what: "WebGL2 only"},
	{name: "canvas-text.webgpu", entry: "src/entries/webgpu.js", what: "WebGPU only"}
]

// dist/ is entirely generated, so rebuild it from empty: nothing hand
// written lives there, and a stale file must not survive a build change.
rmSync(dist, {recursive: true, force: true})
mkdirSync(dist, {recursive: true})

/**
 * Bundle one entry into a scratch directory and copy the output to
 * `dist/<name>`. Building into dist/ directly would collide with the
 * generated file names.
 * @param {string} entry
 * @param {string} name
 * @param {boolean} minify
 */
function bundle(entry, name, minify) {
	rmSync(tmp, {recursive: true, force: true})
	mkdirSync(tmp, {recursive: true})
	let flags = minify ? "--minify --sourcemap=external" : ""
	execSync(`bun build ${entry} --outdir "${tmp}" --target browser ${flags}`, {stdio: "pipe"})
	let files = readdirSync(tmp)
	let js = files.find(f => f.endsWith(".js"))
	if (!js) throw new Error(`bun build produced no .js for ${entry}`)
	let suffix = minify ? ".min.js" : ".js"
	copyFileSync(join(tmp, js), join(dist, `${name}${suffix}`))
	let map = files.find(f => f.endsWith(".js.map"))
	if (map && minify) copyFileSync(join(tmp, map), join(dist, `${name}${suffix}.map`))
}

/** @param {number} bytes */
function fmt(bytes) {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** @type {{name: string, what: string, plain: number, min: number, gz: number}[]} */
const results = []

for (let {name, entry, what} of ENTRIES) {
	bundle(entry, name, false)
	bundle(entry, name, true)

	let plainPath = join(dist, `${name}.js`)
	let minPath = join(dist, `${name}.min.js`)
	if (!existsSync(minPath)) throw new Error(`missing ${minPath}`)
	let min = readFileSync(minPath)
	let plain = readFileSync(plainPath)
	let gz = gzipSync(min)
	writeFileSync(join(dist, `${name}.min.js.gz`), gz)
	results.push({name, what, plain: plain.length, min: min.length, gz: gz.length})
}

rmSync(tmp, {recursive: true, force: true})

console.log("canvas-text bundles")
console.log("────────────────────")
const pad = (s, n) => String(s).padEnd(n)
console.log(`  ${pad("entry", 20)} ${pad("plain", 9)} ${pad("min", 9)} ${pad("gzip", 9)}`)
for (let r of results) {
	console.log(`  ${pad(r.name, 20)} ${pad(fmt(r.plain), 9)} ${pad(fmt(r.min), 9)} ${pad(fmt(r.gz), 9)}  ${r.what}`)
}
console.log("")
let both = results[0], gl = results[1], gpu = results[2]
let savedGl = both.min - gl.min, savedGpu = both.min - gpu.min
console.log(`  dropping the other backend from the combined build saves:`)
console.log(`    webgl2-only  ${fmt(savedGl)} (${Math.round(savedGl / both.min * 100)}% of the combined bundle)`)
console.log(`    webgpu-only  ${fmt(savedGpu)} (${Math.round(savedGpu / both.min * 100)}% of the combined bundle)`)
console.log("")
console.log("  files:")
for (let r of results) {
	console.log(`    dist/${r.name}.js  dist/${r.name}.min.js  (+.map)  dist/${r.name}.min.js.gz`)
}
