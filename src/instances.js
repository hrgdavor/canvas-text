/**
 * Growable typed storage for per-instance GPU data. Each instance is
 * `stride` 32-bit words; the float, uint32 and uint16 views alias the
 * same memory.
 *
 * Backends upload only `[dirtyFrom, count)`: appending instances or
 * patching a range marks just that range, so incremental scenes don't
 * re-upload the whole buffer.
 */
export class InstanceBuffer {
	/**
	 * @param {number} stride - Words per instance
	 * @param {number} [capacity]
	 */
	constructor(stride, capacity = 1024) {
		/** @type {number} */
		this.stride = stride
		/** @type {ArrayBuffer} */
		this.buffer = new ArrayBuffer(capacity * stride * 4)
		/** @type {Float32Array} */
		this.f32 = new Float32Array(this.buffer)
		/** @type {Uint32Array} */
		this.u32 = new Uint32Array(this.buffer)
		/** @type {Uint16Array} */
		this.u16 = new Uint16Array(this.buffer)
		/** @type {number} */
		this.count = 0
		/** @type {number} First instance changed since the backend last uploaded. */
		this.dirtyFrom = 0
	}

	/** @returns {number} */
	get capacity() { return this.f32.length / this.stride }

	/** @returns {number} */
	get byteLength() { return this.count * this.stride * 4 }

	reset() {
		this.count = 0
		this.dirtyFrom = 0
	}

	/**
	 * Note that instances from `index` on were modified in place.
	 * @param {number} index
	 */
	touch(index) {
		if (index < this.dirtyFrom) this.dirtyFrom = index
	}

	/** Called by backends after uploading. */
	markClean() {
		this.dirtyFrom = this.count
	}

	/**
	 * Make room for `n` more instances and return the word offset of the first one.
	 * @param {number} n
	 * @returns {number}
	 */
	alloc(n) {
		let need = this.count + n
		if (need > this.capacity) {
			let cap = this.capacity
			while (cap < need) cap *= 2
			let next = new ArrayBuffer(cap * this.stride * 4)
			new Uint32Array(next).set(this.u32.subarray(0, this.count * this.stride))
			this.buffer = next
			this.f32 = new Float32Array(next)
			this.u32 = new Uint32Array(next)
			this.u16 = new Uint16Array(next)
		}
		let at = this.count * this.stride
		this.touch(this.count)
		this.count = need
		return at
	}
}

/** Glyph instances: x, y (CSS px), atlas u/v and w/h (uint16 pairs), packed RGBA tint. */
export const GLYPH_STRIDE = 5

/** Rect instances: x, y, w, h (CSS px) and a packed RGBA color. */
export const RECT_STRIDE = 5

/**
 * Push a rect instance.
 * @param {InstanceBuffer} buf
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} color - PackedColor
 */
export function pushRect(buf, x, y, w, h, color) {
	if (w <= 0 || h <= 0 || (color >>> 24) == 0) return
	let at = buf.alloc(1)
	let f = buf.f32
	f[at] = x
	f[at + 1] = y
	f[at + 2] = w
	f[at + 3] = h
	buf.u32[at + 4] = color
}

/**
 * Push a glyph instance.
 * @param {InstanceBuffer} buf
 * @param {number} x
 * @param {number} y
 * @param {{u: number, v: number, w: number, h: number, colored: boolean}} g
 * @param {number} color - PackedColor
 */
export function pushGlyph(buf, x, y, g, color) {
	let at = buf.alloc(1)
	buf.f32[at] = x
	buf.f32[at + 1] = y
	let h = (at + 2) * 2
	buf.u16[h] = g.u
	buf.u16[h + 1] = g.v
	buf.u16[h + 2] = g.w
	buf.u16[h + 3] = g.h
	buf.u32[at + 4] = g.colored ? 0 : color
}

/**
 * Push a partial glyph (ligature cut where colors change).
 * @param {InstanceBuffer} buf
 * @param {number} x
 * @param {number} y
 * @param {{u: number, v: number, w: number, h: number, colored: boolean}} g
 * @param {number} du
 * @param {number} w
 * @param {number} color - PackedColor
 */
export function pushGlyphPart(buf, x, y, g, du, w, color) {
	let at = buf.alloc(1)
	buf.f32[at] = x
	buf.f32[at + 1] = y
	let h = (at + 2) * 2
	buf.u16[h] = g.u + du
	buf.u16[h + 1] = g.v
	buf.u16[h + 2] = w
	buf.u16[h + 3] = g.h
	buf.u32[at + 4] = g.colored ? 0 : color
}
