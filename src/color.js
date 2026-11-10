/**
 * @typedef {number} PackedColor
 * A 32-bit integer packing an RGBA color as 0xAABBGGRR.
 */

/**
 * Pack an RGBA color into a single 32-bit integer (0xAABBGGRR).
 * @param {number} r - Red 0-255
 * @param {number} g - Green 0-255
 * @param {number} b - Blue 0-255
 * @param {number} [a] - Alpha 0-255, default 255
 * @returns {PackedColor}
 */
export function packRGBA(r, g, b, a = 255) {
	return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0
}

/**
 * Unpack a PackedColor into [r, g, b, a].
 * @param {PackedColor} c
 * @returns {[number, number, number, number]}
 */
export function unpackRGBA(c) {
	return [c & 0xff, (c >>> 8) & 0xff, (c >>> 16) & 0xff, (c >>> 24) & 0xff]
}

/**
 * Parse a CSS color string into a PackedColor.
 * Supports: #rgb, #rrggbb, #rrggbbaa, rgb(), rgba(), named colors.
 * @param {string} css
 * @returns {PackedColor}
 */
export function parseColor(css) {
	if (css[0] === "#") {
		let h = css.slice(1)
		if (h.length === 3) {
			return packRGBA(parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16))
		}
		if (h.length === 6) {
			return packRGBA(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16))
		}
		if (h.length === 8) {
			return packRGBA(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16))
		}
	}
	// Fallback: use a 2D canvas to resolve any CSS color
	let canvas = document.createElement("canvas")
	canvas.width = canvas.height = 1
	let cx = canvas.getContext("2d")
	if (cx) {
		cx.fillStyle = css
		cx.fillRect(0, 0, 1, 1)
		let [r, g, b, a] = cx.getImageData(0, 0, 1, 1).data
		return packRGBA(r, g, b, a)
	}
	return packRGBA(255, 255, 255)
}

/**
 * Convert a PackedColor to a CSS color string.
 * @param {PackedColor} c
 * @returns {string}
 */
export function colorToCSS(c) {
	let [r, g, b, a] = unpackRGBA(c)
	if (a === 255) return `rgb(${r},${g},${b})`
	return `rgba(${r},${g},${b},${a / 255})`
}
