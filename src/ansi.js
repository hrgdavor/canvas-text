import {packRGBA, parseColor} from "./color.js"

/**
 * @typedef {Object} AnsiStyle
 * @property {number} fg - PackedColor
 * @property {number} bg - PackedColor
 * @property {boolean} bold
 * @property {boolean} italic
 * @property {boolean} underline
 * @property {boolean} strike
 * @property {boolean} inverse
 */

/**
 * @typedef {Object} AnsiRun
 * @property {string} text
 * @property {AnsiStyle} style
 */

// Standard 16-color palette (xterm).
/** @type {string[]} */
const COLORS16 = [
	"#000000", "#cd3131", "#0b6e0b", "#b58900",
	"#3b71dd", "#b23ac7", "#35938c", "#e6e6e6",
	"#555555", "#ff5555", "#55ff55", "#ffff55",
	"#5555ff", "#ff55ff", "#55ffff", "#ffffff"
]

// 256-color palette: 16 + 6x6x6 cube + 24 grayscale.
/** @type {string[]} */
const COLORS256 = []
for (let c of COLORS16) COLORS256.push(c)
for (let r = 0; r < 6; r++)
	for (let g = 0; g < 6; g++)
		for (let b = 0; b < 6; b++) {
			/** @param {number} n @returns {number} */
			const v = n => n == 0 ? 0 : n == 1 ? 0x55 : 0x55 + (n - 2) * 0x33
			COLORS256.push(`rgb(${v(r)},${v(g)},${v(b)})`)
		}
for (let i = 0; i < 24; i++) {
	let v = 8 + i * 10
	COLORS256.push(`rgb(${v},${v},${v})`)
}

/**
 * @typedef {Object} SgrState
 * @property {string|null} fg
 * @property {string|null} bg
 * @property {boolean} bold
 * @property {boolean} italic
 * @property {boolean} underline
 * @property {boolean} strike
 * @property {boolean} inverse
 */

/**
 * Parse a string containing ANSI escape sequences into styled runs.
 * @param {string} text
 * @param {{fg?: number, bg?: number, bold?: boolean, italic?: boolean, underline?: boolean, strike?: boolean, inverse?: boolean}} [defaultStyle]
 * @returns {AnsiRun[]}
 */
export function parseAnsi(text, defaultStyle) {
	/** @type {SgrState} */
	let state = {
		fg: null, bg: null,
		bold: defaultStyle?.bold ?? false,
		italic: defaultStyle?.italic ?? false,
		underline: defaultStyle?.underline ?? false,
		strike: defaultStyle?.strike ?? false,
		inverse: defaultStyle?.inverse ?? false
	}

	/** @type {AnsiRun[]} */
	let runs = []
	/** @type {string} */
	let current = ""
	let i = 0

	/** @param {string} text */
	const push = (text) => {
		if (text) {
			runs.push({
				text,
				style: {
					fg: state.fg ? parseColor(state.fg) : (defaultStyle?.fg ?? packRGBA(200, 200, 200)),
					bg: state.bg ? parseColor(state.bg) : (defaultStyle?.bg ?? 0),
					bold: state.bold,
					italic: state.italic,
					underline: state.underline,
					strike: state.strike,
					inverse: state.inverse
				}
			})
		}
	}

	while (i < text.length) {
		let ch = text[i]
		if (ch === "\x1b") {
			if (i + 1 < text.length && text[i + 1] === "[") {
				let j = i + 2
				let params = ""
				while (j < text.length && ((text[j] >= "0" && text[j] <= "9") || text[j] === ";")) {
					params += text[j]
					j++
				}
				if (j < text.length && text[j] === "m") {
					push(current)
					current = ""
					applySgr(params, state)
					i = j + 1
					continue
				}
			}
			i++
			continue
		}
		current += ch
		i++
	}
	push(current)
	return runs
}

/**
 * Apply SGR parameters to a state object.
 * @param {string} params
 * @param {SgrState} state
 */
function applySgr(params, state) {
	let parts = params ? params.split(";") : ["0"]
	for (let p of parts) {
		let n = p === "" ? 0 : parseInt(p, 10)
		switch (n) {
			case 0:
				state.fg = null; state.bg = null
				state.bold = state.italic = state.underline = state.strike = state.inverse = false
				break
			case 1: state.bold = true; break
			case 3: state.italic = true; break
			case 4: state.underline = true; break
			case 5: state.strike = true; break
			case 7: state.inverse = true; break
			case 21: state.underline = true; break
			case 22: state.bold = false; break
			case 23: state.italic = false; break
			case 24: state.underline = false; break
			case 27: state.inverse = false; break
			case 29: state.strike = false; break
			case 30: case 31: case 32: case 33: case 34: case 35: case 36: case 37:
				state.fg = COLORS16[n - 30]; break
			case 39: state.fg = null; break
			case 40: case 41: case 42: case 43: case 44: case 45: case 46: case 47:
				state.bg = COLORS16[n - 40]; break
			case 49: state.bg = null; break
		}
	}
	// Handle 38;5;N and 38;2;R;G;B (and 48;... for bg)
	if (parts.length >= 3 && (parts[0] === "38" || parts[0] === "48")) {
		let isFg = parts[0] === "38"
		if (parts[1] === "5" && parts.length >= 3) {
			let idx = parseInt(parts[2], 10)
			if (idx >= 0 && idx < 256) {
				let c = COLORS256[idx]
				if (isFg) state.fg = c; else state.bg = c
			}
		} else if (parts[1] === "2" && parts.length >= 5) {
			let r = parseInt(parts[2], 10), g = parseInt(parts[3], 10), b = parseInt(parts[4], 10)
			let c = `rgb(${r},${g},${b})`
			if (isFg) state.fg = c; else state.bg = c
		}
	}
}

/**
 * Parse ANSI and resolve colors to packed values.
 * @param {string} text
 * @param {{fg?: number, bg?: number, bold?: boolean, italic?: boolean, underline?: boolean, strike?: boolean, inverse?: boolean}} [defaultStyle]
 * @returns {AnsiRun[]}
 */
export function parseAnsiResolved(text, defaultStyle) {
	return parseAnsi(text, defaultStyle)
}

/**
 * Remove ANSI escape sequences, leaving only the characters that are
 * actually drawn. Used to map visual columns back to text.
 * @param {string} text
 * @returns {string}
 */
export function stripAnsi(text) {
	if (text.indexOf("\x1b") < 0) return text
	/** @type {string} */
	let out = ""
	let i = 0
	while (i < text.length) {
		let ch = text[i]
		if (ch === "\x1b") {
			if (i + 1 < text.length && text[i + 1] === "[") {
				let j = i + 2
				while (j < text.length && ((text[j] >= "0" && text[j] <= "9") || text[j] === ";")) j++
				if (j < text.length && text[j] === "m") {
					i = j + 1
					continue
				}
			}
			i++
			continue
		}
		out += ch
		i++
	}
	return out
}

/**
 * Expand tabs to the same screen columns the scene draws them at, so a
 * visual column is also a string index (what gets copied matches what is
 * seen).
 * @param {string} text
 * @returns {string}
 */
export function expandTabs(text) {
	if (text.indexOf("\t") < 0) return text
	/** @type {string} */
	let out = ""
	let col = 0
	for (let ch of text) {
		if (ch === "\t") {
			let n = 8 - (col % 8)
			out += " ".repeat(n)
			col += n
		} else {
			out += ch
			col++
		}
	}
	return out
}

export {parseColor} from "./color.js"
