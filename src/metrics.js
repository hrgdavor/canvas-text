/**
 * @typedef {Object} FontSpec
 * @property {string} family - CSS font family
 * @property {number} size - Font size in CSS px
 */

/**
 * @typedef {Object} FontMetrics
 * @property {FontSpec} spec
 * @property {number} dpr - Device pixel ratio
 * @property {number} cellWidthDev - Cell width in device pixels (integer)
 * @property {number} lineHeightDev - Line height in device pixels
 * @property {number} baselineDev - Baseline offset in device pixels
 * @property {number} advanceDev - Advance width in device pixels
 * @property {number} cellWidth - Cell width in CSS px
 * @property {number} lineHeight - Line height in CSS px
 */

/**
 * Create an offscreen canvas (or HTML canvas in a worker).
 * @param {number} w
 * @param {number} h
 * @returns {OffscreenCanvas|HTMLCanvasElement}
 */
export function makeCanvas(w, h) {
	if (typeof OffscreenCanvas !== "undefined") {
		return new OffscreenCanvas(w, h)
	}
	let c = document.createElement("canvas")
	c.width = w
	c.height = h
	return c
}

/**
 * Build a CSS font string.
 * @param {FontSpec} spec
 * @param {number} dpr
 * @param {boolean} [bold]
 * @param {boolean} [italic]
 * @returns {string}
 */
export function fontString(spec, dpr, bold = false, italic = false) {
	let style = italic ? "italic " : ""
	let weight = bold ? "bold " : ""
	return `${style}${weight}${Math.round(spec.size * dpr)}px ${spec.family}`
}

/**
 * Measure a font's metrics.
 * @param {FontSpec} spec
 * @param {number} dpr
 * @returns {FontMetrics}
 */
export function measureFont(spec, dpr) {
	let canvas = makeCanvas(1, 1)
	let cx = /** @type {any} */ (canvas.getContext("2d"))
	cx.font = fontString(spec, dpr)
	let m = cx.measureText("M")
	let advanceDev = Math.round(m.width)
	let cellWidthDev = advanceDev
	let lineHeightDev = Math.round(spec.size * dpr * 1.2)
	let baselineDev = Math.round(spec.size * dpr * 0.8)
	return {
		spec,
		dpr,
		cellWidthDev,
		lineHeightDev,
		baselineDev,
		advanceDev,
		cellWidth: cellWidthDev / dpr,
		lineHeight: lineHeightDev / dpr
	}
}
