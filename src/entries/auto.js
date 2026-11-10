import {CanvasText as BaseCanvasText} from "../view.js"
import {WebGL2Backend} from "../webgl2.js"
import {WebGPUBackend} from "../webgpu.js"

export * from "../api.js"
export {WebGL2Backend, WebGPUBackend}

/**
 * `CanvasText` with both backends bundled. The `backend` option chooses:
 *
 * - `"auto"` (default) — WebGPU when the browser has it, otherwise
 *   WebGL2. This is the fallback case.
 * - `"webgl2"` — WebGL2 only; throws if the browser cannot provide it.
 * - `"webgpu"` — WebGPU only; throws rather than silently drawing with
 *   the other backend, so a benchmark or a feature test cannot end up
 *   measuring the wrong one.
 *
 * Import `canvas-text/webgl2` or `canvas-text/webgpu` instead to ship
 * only one backend.
 */
export class CanvasText extends BaseCanvasText {
	/**
	 * @returns {Promise<WebGL2Backend|WebGPUBackend>}
	 */
	async createBackend() {
		if (this.backendKind === "webgl2") return new WebGL2Backend(this.canvas)
		if (this.backendKind === "webgpu") {
			let gpu = await WebGPUBackend.create(this.canvas)
			if (!gpu) throw new Error("canvas-text: WebGPU was requested but is not available in this browser")
			return gpu
		}
		// "auto": prefer WebGPU, fall back to WebGL2.
		let gpu = await WebGPUBackend.create(this.canvas)
		return gpu || new WebGL2Backend(this.canvas)
	}
}
