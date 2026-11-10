import {fontString, makeCanvas} from "./metrics.js"

/**
 * @typedef {Object} GlyphEntry
 * @property {number} u - Atlas x in texels
 * @property {number} v - Atlas y in texels
 * @property {number} w - Width in texels
 * @property {number} h - Height in texels
 * @property {number} ox - Slot offset x relative to cell top-left (CSS px)
 * @property {number} oy - Slot offset y relative to cell top-left (CSS px)
 * @property {number} cells - Advance in cells
 * @property {boolean} colored - True for color glyphs (emoji)
 */

/**
 * @typedef {Object} DirtyRect
 * @property {number} x
 * @property {number} y
 * @property {number} w
 * @property {number} h
 */

// Right-to-left letters (Hebrew, Arabic, Syriac, Thaana, N'Ko and the
// astral RTL scripts).
const rtlText = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc\u{10800}-\u{10fff}\u{1e800}-\u{1efff}]/u

/** @type {boolean|undefined} */
let rtlBoundsMirrored = undefined

/** Entry for glyphs that draw nothing (spaces, unprintable padding). */
export const EMPTY_GLYPH = {u: 0, v: 0, w: 0, h: 0, ox: 0, oy: 0, cells: 1, colored: false}

/**
 * Font variants: index = (bold ? 1 : 0) | (italic ? 2 : 0).
 * @typedef {0|1|2|3} FontVariant
 */

/**
 * @param {boolean} bold
 * @param {boolean} italic
 * @returns {FontVariant}
 */
/**
 * @param {boolean} bold
 * @param {boolean} italic
 * @returns {FontVariant}
 */
export function fontVariant(bold, italic) {
	return /** @type {FontVariant} */ (((bold ? 1 : 0) | (italic ? 2 : 0)))
}

const colorGlyph = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3|\ufe0f/u

// ASCII characters that can form a ligature run.
export const LIGATURE_CHARS = new Uint8Array(128)
for (let ch of "!#$%&()*+-./:;<=>?@[\\]^_{|}~") LIGATURE_CHARS[ch.charCodeAt(0)] = 1

export const MAX_LIGATURE = 160

const LIGATURE_PROBE = "=> -> != == <= >= && || // :: ++ |> <!--"
const PROBE = -1

// Whether a font shapes a run differently from its characters, per
// font variant and family.
/** @type {Map<string, Map<number|string, boolean>>} */
const shapes = new Map()

/**
 * Packs glyph coverage masks into a single RGBA texture, one entry
 * per (font variant, grapheme); the shader tints them with the
 * instance color, so syntax colors don't multiply atlas entries.
 */
export class GlyphAtlas {
	/**
	 * @param {import("./metrics.js").FontMetrics} metrics
	 * @param {number} [maxTextureSize]
	 * @param {string} [maskColor]
	 */
	constructor(metrics, maxTextureSize = 4096, maskColor = "#fff") {
		/** @type {import("./metrics.js").FontMetrics} */
		this.metrics = metrics
		/** @type {number} */
		this.maxSize = Math.min(4096, maxTextureSize)
		/** @type {number} */
		this.size = Math.min(1024, this.maxSize)
		/** @type {string} */
		this.maskColor = maskColor
		/** @type {OffscreenCanvas|HTMLCanvasElement} */
		this.canvas = makeCanvas(this.size, this.size)
		/** @type {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D} */
		this.cx = /** @type {any} */ (this.canvas.getContext("2d"))
		this.cx.textBaseline = "alphabetic"
		/** @type {(GlyphEntry|undefined)[][]} */
		this.ascii = [[], [], [], []]
		/** @type {Map<string, GlyphEntry>[]} */
		this.other = [new Map(), new Map(), new Map(), new Map()]
		/** @type {Map<string, number>} */
		this.cellCache = new Map()
		/** @type {Map<number|string, GlyphEntry|null>[]} */
		this.ligs = [new Map(), new Map(), new Map(), new Map()]
		/** @type {(boolean|undefined)[]} */
		this.ligFont = []
		/** @type {number} */
		this.ligaturesWanted = 0
		/** @type {number} */
		this.ligatureVersion = 0
		/** @type {Map<number|string, boolean>[]} */
		this.shapes = []
		/** @type {OffscreenCanvas|HTMLCanvasElement|null} */
		this.ligCanvas = null
		/** @type {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D|null} */
		this.ligCx = null
		/** @type {boolean} */
		this.ligatures = false
		/** @type {number} */
		this.padY = Math.ceil(metrics.lineHeightDev * 0.2)
		/** @type {number} */
		this.slotH = Math.ceil(metrics.lineHeightDev) + this.padY * 2
		/** @type {number} */
		this.penX = 0
		/** @type {number} */
		this.penY = 0
		/** @type {DirtyRect|null} */
		this.dirty = null
		/** @type {number} Bumped when the atlas is cleared. */
		this.generation = 0
		/** @type {number} Bumped when the texture must be reallocated. */
		this.sizeVersion = 0
		/** @type {number} */
		this.uploadedTexels = 0
	}

	/**
	 * The advance of a grapheme in cells (fractional).
	 * @param {string} g
	 * @returns {number}
	 */
	cellsOf(g) {
		let code = g.charCodeAt(0)
		if (g.length == 1 && code < 0x300) return 1
		let cached = this.cellCache.get(g)
		if (cached != null) return cached
		let cells = this.measureCells(g)
		this.cellCache.set(g, cells)
		return cells
	}

	/** @param {string} text @returns {number} */
	measureCells(text) {
		this.cx.font = fontString(this.metrics.spec, this.metrics.dpr)
		let ratio = this.cx.measureText(text).width / this.metrics.advanceDev
		let whole = Math.round(ratio)
		return whole > 0 && Math.abs(ratio - whole) < 0.02 * whole ? whole : Math.max(0.25, ratio)
	}

	/**
	 * Look up (rasterizing on demand) the glyph for an ASCII char code.
	 * @param {FontVariant} variant
	 * @param {number} code
	 * @returns {GlyphEntry}
	 */
	asciiGlyph(variant, code) {
		let table = this.ascii[variant]
		return table[code] ?? (table[code] = this.rasterize(variant, String.fromCharCode(code), 1))
	}

	/**
	 * Look up (rasterizing on demand) the glyph for a grapheme.
	 * @param {FontVariant} variant
	 * @param {string} g
	 * @returns {GlyphEntry}
	 */
	glyph(variant, g) {
		if (g.length == 1) {
			let code = g.charCodeAt(0)
			if (code < 128) return this.asciiGlyph(variant, code)
		}
		let map = this.other[variant]
		let found = map.get(g)
		if (!found) map.set(g, found = this.rasterize(variant, g, this.cellsOf(g)))
		return found
	}

	/**
	 * A custom shape drawn with a 2D canvas path into a w×h device-pixel slot.
	 * @param {string} key
	 * @param {number} w
	 * @param {number} h
	 * @param {any} draw
	 * @param {boolean} [colored]
	 * @returns {GlyphEntry}
	 */
	shape(key, w, h, draw, colored = false) {
		let map = this.other[0], fullKey = "\u0002" + key
		let found = map.get(fullKey)
		if (found) return found
		w = Math.min(this.maxSize, Math.ceil(w))
		h = Math.ceil(h)
		while ((w > this.size || h > this.size) && this.size < this.maxSize) this.grow()
		if (this.penX + w > this.size) {
			this.penX = 0
			this.penY += this.slotH
		}
		let rowH = Math.max(this.slotH, h)
		if (this.penY + rowH > this.size) {
			if (this.size < this.maxSize) this.grow()
			else this.clear()
			return this.shape(key, w, h, draw, colored)
		}
		let x = this.penX, y = this.penY
		this.penX += w
		if (rowH > this.slotH) {
			this.penX = 0
			this.penY += rowH
		}
		let cx = this.cx
		cx.save()
		cx.beginPath()
		cx.rect(x, y, w, h)
		cx.clip()
		cx.translate(x, y)
		cx.fillStyle = cx.strokeStyle = this.maskColor
		try { draw(cx) }
		finally { cx.restore() }
		this.markDirty(x, y, x + w, y + h)
		found = {u: x, v: y, w, h, ox: 0, oy: 0, cells: 0, colored}
		map.set(fullKey, found)
		return found
	}

	/**
	 * Rasterize printable ASCII for the given variants ahead of use.
	 * @param {FontVariant[]} variants
	 * @param {number} deadline
	 * @returns {boolean}
	 */
	prewarm(variants, deadline) {
		for (let v of variants) {
			let table = this.ascii[v]
			for (let code = 33; code < 127; code++) {
				if (table[code]) continue
				if (performance.now() > deadline) return false
				table[code] = this.rasterize(v, String.fromCharCode(code), 1)
			}
		}
		return true
	}

	/**
	 * The advance, in cells, of a run of text shaped as a whole.
	 * @param {string} text
	 * @returns {number}
	 */
	shapedCells(text) {
		return this.measureCells(text)
	}

	/**
	 * A run of text rasterized as one unit.
	 * @param {FontVariant} variant
	 * @param {string} text
	 * @param {number} cells
	 * @returns {GlyphEntry}
	 */
	shapedGlyph(variant, text, cells) {
		let map = this.other[variant], key = "\u0001" + text
		let found = map.get(key)
		if (!found) {
			if (variant & 2) {
				this.cx.font = fontString(this.metrics.spec, this.metrics.dpr, (variant & 1) > 0, true)
				let ratio = this.cx.measureText(text).width / (cells * this.metrics.advanceDev)
				if (Math.abs(ratio - 1) > 0.05) variant = /** @type {FontVariant} */ (variant & ~2)
			}
			map.set(key, found = this.rasterize(variant, text, cells))
		}
		return found
	}

	/**
	 * The glyph of a ligature run, or null when the font draws it the
	 * same as its characters one by one.
	 * @param {FontVariant} variant
	 * @param {string} text
	 * @param {number} from
	 * @param {number} to
	 * @returns {GlyphEntry|null}
	 */
	ligature(variant, text, from, to) {
		if (!this.ligaturesOf(variant) || (to - from) * this.metrics.cellWidthDev > this.maxSize) return null
		/** @type {number|string} */
		let key
		if (to - from <= 8) {
			key = 0
			for (let i = from; i < to; i++) key = key * 95 + text.charCodeAt(i) - 32
		} else {
			key = text.slice(from, to)
		}
		let found = this.ligs[variant].get(key)
		if (found === undefined) {
			let run = typeof key == "string" ? key : text.slice(from, to), known = this.shapesOf(variant)
			let differs = known.get(key)
			if (differs == null) known.set(key, differs = this.shapesDifferently(variant, run))
			found = differs ? this.rasterizeRun(variant, run) : null
			this.ligs[variant].set(key, found)
		}
		return found
	}

	/**
	 * Whether the font for `variant` has ligatures.
	 * @param {FontVariant} variant
	 * @returns {boolean}
	 */
	ligaturesOf(variant) {
		let has = this.ligFont[variant]
		if (has == null) {
			has = this.shapesOf(variant).get(PROBE)
			if (has == null) {
				this.ligaturesWanted |= 1 << variant
				return false
			}
			this.ligFont[variant] = has
		}
		return has
	}

	/**
	 * Probe the fonts `ligaturesOf` was asked about.
	 * @returns {boolean}
	 */
	probeLigatures() {
		let found = false
		for (let v = 0; v < 4; v++) {
			if (!(this.ligaturesWanted & (1 << v))) continue
			let variant = /** @type {FontVariant} */ (v)
			let known = this.shapesOf(variant), has = known.get(PROBE)
			if (has == null) known.set(PROBE, has = this.shapesDifferently(variant, LIGATURE_PROBE))
			this.ligFont[v] = has
			if (has) found = true
		}
		this.ligaturesWanted = 0
		if (found) this.ligatureVersion++
		return found
	}

	/** @param {FontVariant} variant @returns {Map<number|string, boolean>} */
	shapesOf(variant) {
		let found = this.shapes[variant]
		if (!found) {
			let id = variant + this.metrics.spec.family
			let shared = shapes.get(id)
			if (!shared) shapes.set(id, shared = new Map())
			found = this.shapes[variant] = shared
		}
		return found
	}

	/** Forget what fonts' shaping was found to be. */
	static fontsChanged() {
		shapes.clear()
	}

	/** @param {FontVariant} variant @param {string} text @returns {boolean} */
	shapesDifferently(variant, text) {
		let m = this.metrics, size = Math.max(24, Math.round(m.spec.size * m.dpr))
		let w = Math.ceil(text.length * size * 0.75 + size * 2), h = Math.ceil(size * 1.6), base = Math.round(size * 1.2)
		let canvas = this.ligCanvas
		if (!canvas || canvas.width < w || canvas.height < h * 2) {
			canvas = this.ligCanvas = makeCanvas(Math.max(w, canvas?.width ?? 0), Math.max(h * 2, canvas?.height ?? 0))
			this.ligCx = /** @type {any} */ (canvas.getContext("2d", {willReadFrequently: true}))
		}
		let cx = this.ligCx
		if (!cx) return false
		cx.font = fontString({...m.spec, size}, 1, (variant & 1) > 0, (variant & 2) > 0)
		cx.fillStyle = "#000"
		cx.textBaseline = "alphabetic"
		w = Math.min(canvas.width, Math.ceil(cx.measureText(text).width) + size * 2)
		cx.clearRect(0, 0, w, h * 2)
		cx.fillText(text, size, base)
		for (let i = 0, x = size; i < text.length; i++) {
			let ch = text[i]
			if (ch != " ") cx.fillText(ch, x, h + base)
			x += cx.measureText(ch).width
		}
		let data = cx.getImageData(0, 0, w, h * 2).data, half = w * h * 4, changed = 0
		for (let i = 3; i < half; i += 4)
			if (Math.abs(data[i] - data[i + half]) > 64 && ++changed > 2) return true
		return false
	}

	/** @param {FontVariant} variant @param {string} text @returns {GlyphEntry} */
	rasterizeRun(variant, text) {
		let m = this.metrics, n = text.length
		this.cx.font = fontString(m.spec, m.dpr, (variant & 1) > 0, (variant & 2) > 0)
		let advance = this.cx.measureText(text).width / n
		let shift = Math.round((n - 1) * (m.cellWidthDev - advance) / 2)
		let g = this.rasterize(variant, text, n)
		return shift ? {...g, ox: g.ox + shift / m.dpr} : g
	}

	/** @param {FontVariant} variant @param {string} g @param {number} cells @returns {GlyphEntry} */
	rasterize(variant, g, cells) {
		if (g == " " || g == "\u00a0") return {...EMPTY_GLYPH, cells}
		let m = this.metrics
		let cx = this.cx
		cx.font = fontString(m.spec, m.dpr, (variant & 1) > 0, (variant & 2) > 0)
		let ink = cx.measureText(g), inkLeft = ink.actualBoundingBoxLeft, inkRight = ink.actualBoundingBoxRight
		if (rtlText.test(g)) {
			if (rtlBoundsMirrored === undefined) {
				let alef = cx.measureText("\u05d0")
				rtlBoundsMirrored = alef.actualBoundingBoxRight < alef.actualBoundingBoxLeft
			}
			if (rtlBoundsMirrored) {
				inkLeft -= ink.width
				inkRight += ink.width
			}
		}
		let left = Math.floor(-inkLeft) - 1
		let right = Math.ceil(inkRight) + 1
		if (!(right > left + 2)) return {...EMPTY_GLYPH, cells}
		let w = Math.min(this.maxSize, right - left), h = this.slotH
		while (w > this.size && this.size < this.maxSize) this.grow()
		if (this.penX + w > this.size) {
			this.penX = 0
			this.penY += h
		}
		if (this.penY + h > this.size) {
			if (this.size < this.maxSize) this.grow()
			else this.clear()
			return this.rasterize(variant, g, cells)
		}
		let x = this.penX, y = this.penY
		this.penX += w
		cx.fillStyle = this.maskColor
		cx.save()
		cx.beginPath()
		cx.rect(x, y, w, h)
		cx.clip()
		cx.fillText(g, x - left, y + this.padY + m.baselineDev)
		cx.restore()
		this.markDirty(x, y, x + w, y + h)
		return {u: x, v: y, w, h, ox: left / m.dpr, oy: -this.padY / m.dpr, cells, colored: colorGlyph.test(g)}
	}

	/** @param {number} x0 @param {number} y0 @param {number} x1 @param {number} y1 */
	markDirty(x0, y0, x1, y1) {
		let d = this.dirty
		if (!d) {
			this.dirty = {x: x0, y: y0, w: x1 - x0, h: y1 - y0}
		} else {
			let nx = Math.min(d.x, x0), ny = Math.min(d.y, y0)
			d.w = Math.max(d.x + d.w, x1) - nx
			d.h = Math.max(d.y + d.h, y1) - ny
			d.x = nx
			d.y = ny
		}
	}

	grow() {
		let old = this.canvas
		this.size *= 2
		this.canvas = makeCanvas(this.size, this.size)
		this.cx = /** @type {any} */ (this.canvas.getContext("2d"))
		this.cx.textBaseline = "alphabetic"
		this.cx.drawImage(old, 0, 0)
		this.sizeVersion++
	}

	/** Drop every glyph. */
	clear() {
		this.cx.clearRect(0, 0, this.size, this.size)
		this.penX = this.penY = 0
		for (let i = 0; i < this.ascii.length; i++) {
			this.ascii[i] = []
			this.other[i] = new Map()
			this.ligs[i] = new Map()
		}
		this.ligFont = []
		this.shapes = []
		this.ligaturesWanted = 0
		this.generation++
		this.dirty = null
	}

	/** @returns {OffscreenCanvas|HTMLCanvasElement} */
	get source() { return this.canvas }

	/** @returns {number} */
	get usedHeight() { return Math.min(this.size, this.penY + this.slotH) }

	/** Mark everything used dirty. */
	markAllDirty() {
		if (this.penY || this.penX) this.markDirty(0, 0, this.size, this.usedHeight)
	}

	/** @returns {DirtyRect|null} */
	takeDirty() {
		let d = this.dirty
		if (!d) return null
		this.dirty = null
		d.w = Math.min(d.w, this.size - d.x)
		d.h = Math.min(d.h, this.size - d.y)
		this.uploadedTexels += d.w * d.h
		return d
	}

	/** @param {DirtyRect} r @returns {Uint8Array} */
	readPremultiplied(r) {
		let img = this.cx.getImageData(r.x, r.y, r.w, r.h)
		let data = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength)
		for (let i = 0; i < data.length; i += 4) {
			let a = data[i + 3]
			if (a == 0) {
				data[i] = data[i + 1] = data[i + 2] = 0
			} else if (a < 255) {
				data[i] = (data[i] * a + 127) / 255
				data[i + 1] = (data[i + 1] * a + 127) / 255
				data[i + 2] = (data[i + 2] * a + 127) / 255
			}
		}
		return data
	}
}
