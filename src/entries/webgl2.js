import {CanvasText as BaseCanvasText} from "../view.js"
import {WebGL2Backend} from "../webgl2.js"

export * from "../api.js"
export {WebGL2Backend}

/**
 * `CanvasText` with WebGL2 only. The `backend` option is ignored: this
 * build always draws with WebGL2, and throws if the browser cannot
 * provide a WebGL2 context.
 */
export class CanvasText extends BaseCanvasText {
	/**
	 * @returns {Promise<WebGL2Backend>}
	 */
	async createBackend() {
		return new WebGL2Backend(this.canvas)
	}
}
