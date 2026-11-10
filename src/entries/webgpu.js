import {CanvasText as BaseCanvasText} from "../view.js"
import {WebGPUBackend} from "../webgpu.js"

export * from "../api.js"
export {WebGPUBackend}

/**
 * `CanvasText` with WebGPU only. The `backend` option is ignored: this
 * build always draws with WebGPU, and throws if the browser cannot
 * provide a device. There is no WebGL2 fallback to fall back to, which
 * keeps the bundle to WebGPU's code only.
 */
export class CanvasText extends BaseCanvasText {
	/**
	 * @returns {Promise<WebGPUBackend>}
	 */
	async createBackend() {
		let gpu = await WebGPUBackend.create(this.canvas)
		if (!gpu) throw new Error("canvas-text/webgpu: WebGPU is not available in this browser")
		return gpu
	}
}
