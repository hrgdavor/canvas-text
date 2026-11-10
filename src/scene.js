import {fontVariant} from "./atlas.js"
import {pushGlyph, pushRect} from "./instances.js"
import {parseAnsiResolved, stripAnsi, expandTabs} from "./ansi.js"

/**
 * @typedef {Object} SceneOptions
 * @property {import("./atlas.js").GlyphAtlas} atlas
 * @property {import("./metrics.js").FontMetrics} metrics
 * @property {import("./instances.js").InstanceBuffer} glyphBuf
 * @property {import("./instances.js").InstanceBuffer} rectBuf
 * @property {number} [background] - PackedColor
 */

/**
 * Builds glyph and rect instances from plain text lines.
 * The scene is the CPU-side layout: it writes directly into instance
 * buffers with no per-glyph allocation.
 */
export class Scene {
	/**
	 * @param {SceneOptions} options
	 */
	constructor(options) {
		/** @type {import("./atlas.js").GlyphAtlas} */
		this.atlas = options.atlas
		/** @type {import("./metrics.js").FontMetrics} */
		this.metrics = options.metrics
		/** @type {import("./instances.js").InstanceBuffer} */
		this.glyphBuf = options.glyphBuf
		/** @type {import("./instances.js").InstanceBuffer} */
		this.rectBuf = options.rectBuf
		/** @type {number} */
		this.background = options.background ?? 0
		/** @type {string[]} */
		this.lines = []
		/**
		 * `lines` without ANSI escapes and with tabs expanded, so a
		 * visual column is a string index. Selection geometry and the
		 * clipboard both use these.
		 * @type {string[]}
		 */
		this.plain = []
		/** @type {number} */
		this.version = 0
	}

	/**
	 * Set the text content.
	 * @param {string} text
	 */
	setText(text) {
		this.lines = text.split("\n")
		this.plain = this.lines.map(line => expandTabs(stripAnsi(line)).replace(/\r/g, ""))
		this.version++
	}

	/**
	 * @typedef {Object} Selection
	 * @property {number} startLine
	 * @property {number} startCol
	 * @property {number} endLine
	 * @property {number} endCol
	 */

	/**
	 * Build instances for the visible rows.
	 *
	 * Positions are in content space: `x = column * cellWidth`, `y = row *
	 * lineHeight`. The horizontal and vertical pass offsets translate that
	 * to the screen, exactly as they do for rows, so scrolling is applied
	 * once, in one place. (Subtracting the scroll here as well as in the
	 * offset would cancel it out and draw nothing.)
	 *
	 * @param {number} firstRow - First visible row
	 * @param {number} lastRow - Last visible row (inclusive)
	 * @param {Selection|null} [selection]
	 * @param {number} [selectionColor] - PackedColor
	 * @returns {{glyphCount: number, rectCount: number}}
	 */
	build(firstRow, lastRow, selection, selectionColor) {
		let m = this.metrics
		let cellW = m.cellWidth
		let lh = m.lineHeight
		let buf = this.glyphBuf
		let rbuf = this.rectBuf
		buf.reset()
		rbuf.reset()

		// Selection background (drawn first, under the glyphs).
		if (selection) {
			let selColor = selectionColor ?? 0x3c5a8c
			for (let row = firstRow; row <= lastRow; row++) {
				if (row < selection.startLine || row > selection.endLine) continue
				let line = this.plain[row]
				if (line == null) continue
				// Columns are clamped to the line: a selection that runs
				// past the end of a line only covers what exists. The
				// newline itself is shown as one cell on every row the
				// selection continues past.
				let colStart = row === selection.startLine ? selection.startCol : 0
				let colEnd = row === selection.endLine ? selection.endCol : line.length
				colStart = Math.max(0, Math.min(colStart, line.length))
				colEnd = Math.max(0, Math.min(colEnd, line.length))
				if (colEnd <= colStart) {
					if (row === selection.endLine) continue
					colStart = line.length
					colEnd = line.length + 1
				}
				let x = colStart * cellW
				let w = (colEnd - colStart) * cellW
				pushRect(rbuf, x, row * lh, w, lh, selColor)
			}
		}

		for (let row = firstRow; row <= lastRow; row++) {
			let line = this.lines[row]
			if (line == null) continue
			let y = row * lh
			let runs = parseAnsiResolved(line)
			let col = 0
			for (let run of runs) {
				let style = run.style
				let variant = fontVariant(style.bold, style.italic)
				let fg = typeof style.fg === "number" ? style.fg : 0xcccccc
				for (let i = 0; i < run.text.length; i++) {
					let ch = run.text[i]
					if (ch === "\t") {
						// Tab: advance to next multiple of 8
						col = Math.ceil((col + 1) / 8) * 8
						continue
					}
					if (ch === "\r" || ch === "\n") continue
					let x = col * cellW
					let g = this.atlas.glyph(variant, ch)
					pushGlyph(buf, x, y, g, fg)
					if (style.underline) {
						pushRect(rbuf, x, y + lh - Math.max(1, lh * 0.12), cellW, 1, fg)
					}
					if (style.strike) {
						pushRect(rbuf, x, y + lh * 0.45, cellW, 1, fg)
					}
					col++
				}
			}
		}
		return {glyphCount: buf.count, rectCount: rbuf.count}
	}
}
