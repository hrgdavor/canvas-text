import {GlyphAtlas} from "./atlas.js"
import {InstanceBuffer} from "./instances.js"
import {measureFont} from "./metrics.js"
import {packRGBA} from "./color.js"
import {Scene} from "./scene.js"
import {ScrollController} from "./scroll.js"

/**
 * Type-only union of the two backends. Nothing here imports them at
 * runtime: the entry module you import decides which one is bundled, so
 * building against only WebGL2 or only WebGPU leaves the other's code
 * out of the bundle entirely.
 * @typedef {import("./webgl2.js").WebGL2Backend | import("./webgpu.js").WebGPUBackend} Backend
 */

/**
 * @typedef {Object} ClickInfo
 * @property {number} line - 0-based line index under the pointer
 * @property {number} col - 0-based column under the pointer, ANSI-free
 * @property {string} text - the whole line at `line`, ANSI-free
 * @property {number} count - 1 for a click, 2 for a double, 3 for a triple
 */

/**
 * @typedef {Object} CanvasTextOptions
 * @property {HTMLCanvasElement} canvas
 * @property {string} [font] - CSS font family
 * @property {number} [size] - Font size in CSS px
 * @property {number} [background] - PackedColor
 * @property {"webgl2"|"webgpu"} [backend]
 * @property {number} [scrollSpeed] - Fling velocity multiplier (1 = Android's own feel)
 * @property {number} [selectionColor] - PackedColor for selection background
 * @property {(hit: ClickInfo) => void} [onClick] - Called when the text is clicked
 */

/// Characters that make up a word for double-click selection. JSON
/// punctuation is excluded, so a double click inside a payload picks out
/// one value rather than the whole line.
const WORD_CHARS = /[\w$@.\-]/

/**
 * Word boundaries around `col`. A click on punctuation selects that one
 * character, so double-clicking never selects nothing.
 * @param {string} text
 * @param {number} col
 * @returns {{start: number, end: number}}
 */
function wordRange(text, col) {
	col = Math.max(0, Math.min(col, text.length))
	let start = col, end = col
	while (start > 0 && WORD_CHARS.test(text[start - 1])) start--
	while (end < text.length && WORD_CHARS.test(text[end])) end++
	if (start === end) end = Math.min(text.length, col + 1)
	return {start, end}
}

/**
 * A GPU text renderer for plain text with ANSI colors.
 * No DOM for text: glyphs and rects are drawn with instanced GPU draws.
 * Owns its scrolling with Android's fling physics. Every frame on screen
 * is fully drawn: no blank areas during fast flings, even on slow
 * Android WebViews.
 */
export class CanvasText {
	/**
	 * @param {CanvasTextOptions} options
	 */
	constructor(options) {
		/** @type {HTMLCanvasElement} */
		this.canvas = options.canvas
		/** @type {string} */
		this.font = options.font ?? "Consolas, 'Cascadia Code', monospace"
		/** @type {number} */
		this.size = options.size ?? 14
		/** @type {number} */
		this.background = options.background ?? packRGBA(30, 30, 30)
		/**
		 * Which backend to ask for. Only the entry module interprets it:
		 * `canvas-text` understands "auto" (WebGPU, else WebGL2),
		 * "webgl2" and "webgpu"; the single-backend entries ignore it.
		 * @type {"auto"|"webgl2"|"webgpu"}
		 */
		this.backendKind = options.backend ?? "auto"
		/** @type {number} */
		this.scrollSpeed = options.scrollSpeed ?? 1

		/** @type {import("./metrics.js").FontMetrics|null} */
		this.metrics = null
		/** @type {GlyphAtlas|null} */
		this.atlas = null
		/** @type {Backend|null} */
		this.backend = null
		/** @type {InstanceBuffer} */
		this.glyphBuf = new InstanceBuffer(5)
		/** @type {InstanceBuffer} */
		this.rectBuf = new InstanceBuffer(5)
		/** @type {Scene|null} */
		this.scene = null
		/** @type {ScrollController|null} */
		this.scroller = null
		/** @type {number} */
		this.width = 0
		/** @type {number} */
		this.height = 0
		/** @type {number} */
		this.dpr = 1
		/** @type {boolean} */
		this.destroyed = false
		/** @type {number} */
		this._raf = 0
		/** @type {boolean} */
		this._needsRender = false
		/** @type {string[]} */
		this._lines = []
		/**
		 * The same lines with ANSI escapes removed and tabs expanded:
		 * visual columns index into these, so a selection maps back to
		 * text without knowing anything about styling.
		 * @type {string[]}
		 */
		this._plain = []
		/** @type {{line: number, col: number}|null} */
		this.selStart = null
		/** @type {{line: number, col: number}|null} */
		this.selEnd = null
		/** @type {boolean} */
		this._selecting = false
		/** @type {boolean} */
		this._dragged = false
		/** @type {number} */
		this._downX = 0
		/** @type {number} */
		this._downY = 0
		/** @type {number} */
		this._clickCount = 0
		/** @type {number} */
		this._lastClickTime = 0
		/** @type {{line: number, col: number}|null} */
		this._lastClickPos = null
		/** @type {number} */
		this._pointerX = 0
		/** @type {number} */
		this._pointerY = 0
		/** @type {number} */
		this._autoRaf = 0
		/** @type {number} */
		this.selectionColor = options.selectionColor ?? packRGBA(60, 90, 140)
		/**
		 * Called with the line and column under a click, plus that
		 * line's text, so a host can open a side panel or log it.
		 * @type {((hit: ClickInfo) => void)|null}
		 */
		this.onClick = options.onClick ?? null
	}

	/**
	 * Create the render backend.
	 *
	 * The base class does not know about any backend, so importing this
	 * module alone pulls in neither. The entry modules
	 * (`canvas-text`, `canvas-text/webgl2`, `canvas-text/webgpu`)
	 * override this, which is what lets a single-backend build drop the
	 * other backend's code from the bundle.
	 *
	 * @returns {Promise<Backend>}
	 */
	async createBackend() {
		throw new Error(
			"canvas-text: no backend is bundled. Import \"canvas-text\" for both " +
			"backends with fallback, or \"canvas-text/webgl2\" / \"canvas-text/webgpu\" " +
			"for a single one."
		)
	}

	/**
	 * Initialize the renderer. Must be called before rendering.
	 * @returns {Promise<void>}
	 */
	async init() {
		this.dpr = window.devicePixelRatio || 1
		this.metrics = measureFont({family: this.font, size: this.size}, this.dpr)
		this.atlas = new GlyphAtlas(this.metrics, 4096)
		this.scene = new Scene({
			atlas: this.atlas,
			metrics: this.metrics,
			glyphBuf: this.glyphBuf,
			rectBuf: this.rectBuf,
			background: this.background
		})
		this.backend = await this.createBackend()
		this.resize()
		// Create the scroll controller. The view owns its scrolling:
		// no native overflow, so what's drawn always matches the scroll
		// position and a fling can't outrun rendering.
		this.scroller = new ScrollController({
			surface: this.canvas,
			dpr: this.dpr,
			maxScrollTop: 0,
			maxScrollLeft: 0,
			scrollSpeed: this.scrollSpeed,
			requestFrame: () => { this._needsRender = true },
			noteInput: () => {}
		})
		// Mouse selection (touch is handled by the scroller). The move and
		// up listeners are added on the window for the duration of a drag.
		this.canvas.style.cursor = "text"
		this.canvas.addEventListener("pointerdown", this._onPointerDown)
	}

	/**
	 * Convert a position in canvas CSS pixels to line/col.
	 * @param {number} x
	 * @param {number} y
	 * @returns {{line: number, col: number}}
	 */
	_posToLineCol(x, y) {
		let m = /** @type {import("./metrics.js").FontMetrics} */ (this.metrics)
		let s = /** @type {ScrollController} */ (this.scroller)
		// scrollTop/scrollLeft are CSS px, like x and y and the metrics.
		let line = Math.floor((y + s.scrollTop) / m.lineHeight)
		let col = Math.floor((x + s.scrollLeft) / m.cellWidth)
		line = Math.max(0, line)
		col = Math.max(0, col)
		// Past the last line the position is that line's end, and past
		// the end of a line it is the line's end, so a drag that leaves
		// the text does not overshoot.
		if (this._plain.length && line > this._plain.length - 1) line = this._plain.length - 1
		let text = this._plain[line]
		if (text != null && col > text.length) col = text.length
		return {line, col}
	}

	/**
	 * @param {number} clientX
	 * @param {number} clientY
	 * @returns {{line: number, col: number}}
	 */
	_posToLineColClient(clientX, clientY) {
		let rect = this.canvas.getBoundingClientRect()
		return this._posToLineCol(clientX - rect.left, clientY - rect.top)
	}

	// These are arrow properties, not methods: addEventListener calls a
	// listener with `this` bound to the target, so a plain method would
	// lose the instance.
	/**
	 * @param {PointerEvent} e
	 */
	_onPointerDown = (e) => {
		// Touch drags scroll; only the mouse selects.
		if (e.pointerType !== "mouse" || e.button !== 0) return
		if (!this.metrics || !this.scroller) return
		let pos = this._posToLineColClient(e.clientX, e.clientY)
		this.selStart = pos
		this.selEnd = pos
		this._selecting = true
		this._dragged = false
		this._downX = e.clientX
		this._downY = e.clientY
		this._pointerX = e.clientX
		this._pointerY = e.clientY
		// Track on the window: a drag that leaves the canvas keeps
		// extending the selection and still sees the button release.
		window.addEventListener("pointermove", this._onPointerMove)
		window.addEventListener("pointerup", this._onPointerUp)
		e.preventDefault()
		this._needsRender = true
	}

	/**
	 * @param {PointerEvent} e
	 */
	_onPointerMove = (e) => {
		if (!this._selecting) return
		this._pointerX = e.clientX
		this._pointerY = e.clientY
		// A few pixels of jitter are still a click, not a drag.
		if (Math.abs(e.clientX - this._downX) > 3 || Math.abs(e.clientY - this._downY) > 3) {
			this._dragged = true
		}
		if (this._dragged) {
			let pos = this._posToLineColClient(e.clientX, e.clientY)
			if (!this.selEnd || pos.line !== this.selEnd.line || pos.col !== this.selEnd.col) {
				this.selEnd = pos
				this._needsRender = true
			}
			// Dragging past an edge keeps scrolling and extending.
			if (!this._autoRaf) this._autoRaf = requestAnimationFrame(this._autoScroll)
		}
	}

	/**
	 * Scroll toward a pointer held outside the canvas and move the
	 * selection head with it.
	 */
	_autoScroll = () => {
		this._autoRaf = 0
		if (!this._selecting || !this.scroller) return
		let rect = this.canvas.getBoundingClientRect()
		let up = this._pointerY < rect.top ? this._pointerY - rect.top : 0
		let down = this._pointerY > rect.bottom ? this._pointerY - rect.bottom : 0
		let left = this._pointerX < rect.left ? this._pointerX - rect.left : 0
		let right = this._pointerX > rect.right ? this._pointerX - rect.right : 0
		let dy = up || down, dx = left || right
		if (!dy && !dx) return
		// Faster the further out the pointer is, capped so a stray
		// pointer far off-screen cannot teleport the view.
		/** @param {number} d */
		let speed = (d) => Math.min(60, Math.max(2, Math.abs(d) * 0.5))
		this.scroller.scrollTop += Math.sign(dy) * speed(dy)
		this.scroller.scrollLeft += Math.sign(dx) * speed(dx)
		this.scroller.clamp()
		this.selEnd = this._posToLineColClient(this._pointerX, this._pointerY)
		this._needsRender = true
		this._autoRaf = requestAnimationFrame(this._autoScroll)
	}

	/**
	 * Line and column under a client (viewport) position, for your own
	 * hit testing: context menus, hover, a side panel following the
	 * pointer. Positions below the last line clamp to it.
	 * @param {number} clientX
	 * @param {number} clientY
	 * @returns {{line: number, col: number}}
	 */
	posAt(clientX, clientY) {
		return this._posToLineColClient(clientX, clientY)
	}

	/**
	 * One line's text, ANSI escapes removed and tabs expanded — the same
	 * string `getSelectedText()` returns for a range.
	 * @param {number} line
	 * @returns {string}
	 */
	getLine(line) {
		return this._plain[line] ?? ""
	}

	/**
	 * Finish a drag, or resolve a click into a word or line selection.
	 */
	_onPointerUp = () => {
		this._selecting = false
		if (this._autoRaf) cancelAnimationFrame(this._autoRaf)
		this._autoRaf = 0
		window.removeEventListener("pointermove", this._onPointerMove)
		window.removeEventListener("pointerup", this._onPointerUp)
		if (!this._dragged) this._resolveClick()
		this._needsRender = true
	}

	/**
	 * A click that did not drag: the second select the word under the
	 * pointer, the third the whole line. Selecting a line in one gesture
	 * is how a line wider than the viewport gets copied in full.
	 */
	_resolveClick() {
		let pos = this.selStart
		if (!pos) return
		let now = performance.now()
		let last = this._lastClickPos
		let sameSpot = !!last && last.line === pos.line && Math.abs(last.col - pos.col) <= 1
		this._clickCount = now - this._lastClickTime < 500 && sameSpot ? this._clickCount + 1 : 1
		this._lastClickTime = now
		this._lastClickPos = pos
		// Report the click before resolving it to a word or line, so the
		// host sees the position that was actually clicked.
		if (this.onClick) {
			this.onClick({
				line: pos.line,
				col: pos.col,
				text: this._plain[pos.line] ?? "",
				count: this._clickCount
			})
		}
		if (this._clickCount < 2) return
		let text = this._plain[pos.line] ?? ""
		if (this._clickCount === 2) {
			let r = wordRange(text, pos.col)
			this.selStart = {line: pos.line, col: r.start}
			this.selEnd = {line: pos.line, col: r.end}
		} else {
			this.selStart = {line: pos.line, col: 0}
			this.selEnd = {line: pos.line, col: text.length}
		}
	}

	/**
	 * Clear the selection.
	 */
	clearSelection() {
		this.selStart = null
		this.selEnd = null
		this._needsRender = true
	}

	/**
	 * Get the normalized selection range.
	 * @returns {{startLine: number, startCol: number, endLine: number, endCol: number}|null}
	 */
	getSelection() {
		if (!this.selStart || !this.selEnd) return null
		let a = this.selStart, b = this.selEnd
		let start, end
		if (a.line < b.line || (a.line === b.line && a.col <= b.col)) {
			start = a; end = b
		} else {
			start = b; end = a
		}
		return {startLine: start.line, startCol: start.col, endLine: end.line, endCol: end.col}
	}

	/**
	 * Get the full text for the current selection.
	 * Returns full lines even if partially visible (no-wrap).
	 * @returns {string}
	 */
	getSelectedText() {
		let sel = this.getSelection()
		if (!sel) return ""
		let parts = []
		for (let line = sel.startLine; line <= sel.endLine; line++) {
			let text = this._plain[line] ?? ""
			if (line === sel.startLine && line === sel.endLine) {
				parts.push(text.slice(sel.startCol, sel.endCol))
			} else if (line === sel.startLine) {
				parts.push(text.slice(sel.startCol))
			} else if (line === sel.endLine) {
				parts.push(text.slice(0, sel.endCol))
			} else {
				parts.push(text)
			}
		}
		return parts.join("\n")
	}

	/**
	 * Copy the selected text to the clipboard.
	 * @returns {Promise<void>}
	 */
	async copySelection() {
		let text = this.getSelectedText()
		if (text) await navigator.clipboard.writeText(text)
	}

	/**
	 * Set the text content.
	 * @param {string} text
	 */
	setText(text) {
		if (!this.scene || !this.metrics) return
		this.scene.setText(text)
		this._lines = this.scene.lines
		// The scene owns the plain projection: visual columns index it.
		this._plain = this.scene.plain
		this._updateMaxScroll()
		this._needsRender = true
	}

	/**
	 * Update the max scroll bounds based on content size.
	 */
	_updateMaxScroll() {
		if (!this.scroller || !this.metrics) return
		let totalHeight = this._plain.length * this.metrics.lineHeight
		let totalWidth = 0
		// Width is in cells as drawn, so measure the plain text.
		for (let line of this._plain) {
			if (line.length > totalWidth) totalWidth = line.length
		}
		let contentWidth = totalWidth * this.metrics.cellWidth
		this.scroller.host.maxScrollTop = Math.max(0, totalHeight - this.height)
		this.scroller.host.maxScrollLeft = Math.max(0, contentWidth - this.width)
	}

	/**
	 * Resize to the canvas's CSS dimensions.
	 */
	resize() {
		if (!this.backend) return
		let rect = this.canvas.getBoundingClientRect()
		this.width = rect.width
		this.height = rect.height
		this.dpr = window.devicePixelRatio || 1
		this.backend.resize(this.width, this.height, this.dpr)
		this._updateMaxScroll()
		this._needsRender = true
	}

	/**
	 * Render one frame.
	 */
	render() {
		if (this.destroyed || !this.backend || !this.scene || !this.metrics || !this.atlas || !this.scroller) return
		let m = this.metrics
		// Advance the fling: position is a function of time, so a slow
		// frame never shortens a fling.
		this.scroller.step(performance.now())
		let scrollY = this.scroller.scrollTop
		let firstRow = Math.floor(scrollY / m.lineHeight)
		let lastRow = firstRow + Math.ceil(this.height / m.lineHeight) + 1
		let sel = this.getSelection()
		this.scene.build(firstRow, lastRow, sel, this.selectionColor)
		// Instances are laid out in content space; the pass offsets are
		// the only place scrolling is applied, for both axes.
		let offsetX = -this.scroller.scrollLeft
		let offsetY = -scrollY
		let passes = [
			{kind: "rect", buffer: this.rectBuf, first: 0, count: this.rectBuf.count, offsetX, offsetY},
			{kind: "glyph", buffer: this.glyphBuf, first: 0, count: this.glyphBuf.count, offsetX, offsetY}
		]
		this.backend.syncAtlas(this.atlas)
		this.backend.render(this.background, passes)
	}

	/**
	 * Start the render loop.
	 */
	start() {
		if (this.destroyed) return
		const loop = () => {
			if (this.destroyed) return
			this.render()
			this._raf = requestAnimationFrame(loop)
		}
		this._raf = requestAnimationFrame(loop)
	}

	/**
	 * Stop the render loop.
	 */
	stop() {
		cancelAnimationFrame(this._raf)
		this._raf = 0
	}

	/**
	 * Destroy the renderer and release GPU resources.
	 */
	destroy() {
		this.destroyed = true
		this.stop()
		if (this._autoRaf) cancelAnimationFrame(this._autoRaf)
		this._autoRaf = 0
		this.canvas.removeEventListener("pointerdown", this._onPointerDown)
		window.removeEventListener("pointermove", this._onPointerMove)
		window.removeEventListener("pointerup", this._onPointerUp)
		this.scroller?.destroy()
		this.backend?.destroy()
		this.glyphBuf.reset()
		this.rectBuf.reset()
	}
}
