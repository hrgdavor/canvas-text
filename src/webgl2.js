import {unpackRGBA} from "./color.js"
import {GLYPH_STRIDE, RECT_STRIDE} from "./instances.js"

const header = `#version 300 es
precision highp float;
precision highp int;
uniform vec2 u_viewport;
uniform vec2 u_offset;
uniform float u_dpr;
vec2 corner() { return vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)); }
vec2 snap(vec2 p) { return floor(p * u_dpr + 0.5); }
vec4 clip(vec2 p) { return vec4(p.x / u_viewport.x * 2.0 - 1.0, 1.0 - p.y / u_viewport.y * 2.0, 0.0, 1.0); }
`

const vertexShader = header + `
uniform bool u_rect;
layout(location = 0) in vec4 a_box;
layout(location = 1) in vec2 a_uv;
layout(location = 2) in vec2 a_size;
layout(location = 3) in vec4 a_color;
uniform vec2 u_atlas;
out vec2 v_uv;
flat out vec4 v_color;
void main() {
  vec2 c = corner();
  vec2 off = snap(u_offset);
  if (u_rect) {
    vec2 a = snap(a_box.xy) + off;
    vec2 b = max(snap(a_box.xy + a_box.zw) + off, a + 1.0);
    v_uv = vec2(0.0);
    v_color = vec4(a_color.rgb * a_color.a, a_color.a);
    gl_Position = clip(mix(a, b, c));
  } else {
    vec2 origin = snap(a_box.xy) + off;
    v_uv = (a_uv + c * a_size) / u_atlas;
    v_color = a_color;
    gl_Position = clip(origin + c * a_size);
  }
}`

const fragmentShader = `#version 300 es
precision mediump float;
uniform bool u_rect;
uniform sampler2D u_tex;
in vec2 v_uv;
flat in vec4 v_color;
out vec4 o;
void main() {
  if (u_rect) {
    o = v_color;
  } else {
    vec4 t = texture(u_tex, v_uv);
    o = v_color.a == 0.0 ? t : vec4(v_color.rgb, 1.0) * (t.a * v_color.a);
  }
}`

if (GLYPH_STRIDE != RECT_STRIDE) throw new Error("canvas-text: glyph and rect instances must be the same size")
const STRIDE_BYTES = GLYPH_STRIDE * 4

/**
 * @typedef {Object} Program
 * @property {WebGLProgram} program
 * @property {WebGLVertexArrayObject} vao
 * @property {WebGLUniformLocation|null} viewport
 * @property {WebGLUniformLocation|null} offset
 * @property {WebGLUniformLocation|null} dpr
 * @property {WebGLUniformLocation|null} atlas
 * @property {WebGLUniformLocation|null} rect
 */

/**
 * @typedef {Object} BufferState
 * @property {WebGLBuffer} buffer
 * @property {number} bytes
 */

/**
 * WebGL2 render backend.
 */
export class WebGL2Backend {
	/**
	 * @param {HTMLCanvasElement} canvas
	 * @param {{lowLatency?: boolean}} [options]
	 */
	constructor(canvas, options = {}) {
		/** @type {"webgl2"} */
		this.kind = "webgl2"
		/** @type {HTMLCanvasElement} */
		this.canvas = canvas
		/** @type {boolean} */
		this.lost = false
		/** @type {((permanent: boolean) => void)|null} */
		this.onLost = null
		/** @type {(() => void)|null} */
		this.onRestored = null
		/** @type {number} */
		this.maxTextureSize = 0

		/** @type {WebGL2RenderingContext} */
		this.gl = /** @type {WebGL2RenderingContext} */ (canvas.getContext("webgl2", {
			alpha: false, antialias: false, depth: false, stencil: false,
			premultipliedAlpha: true, preserveDrawingBuffer: false,
			desynchronized: !!options.lowLatency, powerPreference: "default"
		}))
		if (!this.gl) throw new Error("canvas-text: WebGL2 is not available")

		this.lost = this.gl.isContextLost()
		this.maxTextureSize = this.lost ? 4096 : this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE)
		if (!this.lost) this.init()

		/** @type {WeakMap<import("./instances.js").InstanceBuffer, BufferState>} */
		this.buffers = new WeakMap()
		/** @type {WebGLTexture|null} */
		this.texture = null
		/** @type {number} */
		this.textureSize = 0
		/** @type {import("./atlas.js").GlyphAtlas|null} */
		this.atlas = null
		/** @type {number} */
		this.width = 1
		/** @type {number} */
		this.height = 1
		/** @type {number} */
		this.dpr = 1
		/** @type {number} */
		this.atlasSize = 1

		canvas.addEventListener("webglcontextlost", this.handleLost)
		canvas.addEventListener("webglcontextrestored", this.handleRestored)
	}

	/** @param {Event} e */
	handleLost = (e) => {
		e.preventDefault()
		this.lost = true
		this.onLost?.(false)
	}

	handleRestored = () => {
		this.buffers = new WeakMap()
		this.texture = null
		this.textureSize = 0
		this.init()
		this.lost = false
		this.onRestored?.()
	}

	init() {
		let gl = this.gl
		this.program = this.link(vertexShader, fragmentShader)
		gl.disable(gl.DEPTH_TEST)
		gl.enable(gl.BLEND)
		gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
	}

	/** @param {string} vs @param {string} fs @returns {Program} */
	link(vs, fs) {
		let gl = this.gl
		/** @param {number} type @param {string} src @returns {WebGLShader} */
		let compile = (type, src) => {
			let s = /** @type {WebGLShader} */ (gl.createShader(type))
			gl.shaderSource(s, src)
			gl.compileShader(s)
			if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
				throw new Error("canvas-text: shader compile failed: " + gl.getShaderInfoLog(s))
			return s
		}
		let program = /** @type {WebGLProgram} */ (gl.createProgram())
		gl.attachShader(program, compile(gl.VERTEX_SHADER, vs))
		gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fs))
		gl.linkProgram(program)
		if (!gl.getProgramParameter(program, gl.LINK_STATUS))
			throw new Error("canvas-text: program link failed: " + gl.getProgramInfoLog(program))
		let vao = /** @type {WebGLVertexArrayObject} */ (gl.createVertexArray())
		return {
			program, vao,
			viewport: gl.getUniformLocation(program, "u_viewport"),
			offset: gl.getUniformLocation(program, "u_offset"),
			dpr: gl.getUniformLocation(program, "u_dpr"),
			atlas: gl.getUniformLocation(program, "u_atlas"),
			rect: gl.getUniformLocation(program, "u_rect")
		}
	}

	/**
	 * @param {number} width
	 * @param {number} height
	 * @param {number} dpr
	 * @returns {boolean}
	 */
	resize(width, height, dpr) {
		this.width = Math.round(width * dpr)
		this.height = Math.round(height * dpr)
		this.dpr = dpr
		if (this.canvas.width == this.width && this.canvas.height == this.height) return false
		this.canvas.width = this.width
		this.canvas.height = this.height
		return true
	}

	/** @param {number} size @returns {WebGLTexture} */
	createTexture(size) {
		let gl = this.gl
		let tex = /** @type {WebGLTexture} */ (gl.createTexture())
		gl.bindTexture(gl.TEXTURE_2D, tex)
		gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, size, size)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
		return tex
	}

	/**
	 * @param {import("./atlas.js").GlyphAtlas} atlas
	 */
	syncAtlas(atlas) {
		if (this.lost) return
		let gl = this.gl
		if (!this.texture || atlas != this.atlas || this.textureSize > atlas.size) {
			if (this.texture) gl.deleteTexture(this.texture)
			this.texture = this.createTexture(atlas.size)
			this.textureSize = atlas.size
			atlas.markAllDirty()
		} else if (this.textureSize < atlas.size) {
			let old = this.texture, oldSize = this.textureSize
			let fbo = /** @type {WebGLFramebuffer} */ (gl.createFramebuffer())
			gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo)
			gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, old, 0)
			this.texture = this.createTexture(atlas.size)
			gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, oldSize, oldSize)
			gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
			gl.deleteFramebuffer(fbo)
			gl.deleteTexture(old)
			this.textureSize = atlas.size
		}
		this.atlas = atlas
		this.atlasSize = atlas.size
		let d = atlas.takeDirty()
		if (!d || d.w <= 0 || d.h <= 0) return
		gl.bindTexture(gl.TEXTURE_2D, this.texture)
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
		gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, d.x)
		gl.pixelStorei(gl.UNPACK_SKIP_ROWS, d.y)
		gl.texSubImage2D(gl.TEXTURE_2D, 0, d.x, d.y, d.w, d.h, gl.RGBA, gl.UNSIGNED_BYTE, atlas.source)
		gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
		gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
		gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
	}

	/** @param {import("./instances.js").InstanceBuffer} buf */
	upload(buf) {
		let gl = this.gl
		let state = this.buffers.get(buf)
		if (!state) {
			state = {buffer: /** @type {WebGLBuffer} */ (gl.createBuffer()), bytes: 0}
			this.buffers.set(buf, state)
		}
		gl.bindBuffer(gl.ARRAY_BUFFER, state.buffer)
		let from = buf.dirtyFrom
		if (buf.byteLength > state.bytes) {
			state.bytes = buf.buffer.byteLength
			gl.bufferData(gl.ARRAY_BUFFER, state.bytes, gl.DYNAMIC_DRAW)
			from = 0
		}
		if (from < buf.count) {
			let w = buf.stride
			gl.bufferSubData(gl.ARRAY_BUFFER, from * w * 4, buf.u32, from * w, (buf.count - from) * w)
		}
		buf.markClean()
	}

	/**
	 * @param {number} background - PackedColor
	 * @param {Array<{kind: string, buffer: import("./instances.js").InstanceBuffer, first: number, count: number, offsetX: number, offsetY: number, clip?: {x: number, y: number, w: number, h: number}}>} passes
	 */
	render(background, passes) {
		if (this.lost) return
		let gl = this.gl
		gl.viewport(0, 0, this.width, this.height)
		gl.disable(gl.SCISSOR_TEST)
		let [r, g, b] = unpackRGBA(background)
		gl.clearColor(r / 255, g / 255, b / 255, 1)
		gl.clear(gl.COLOR_BUFFER_BIT)
		let p = /** @type {Program} */ (this.program)
		let rect = null
		gl.useProgram(p.program)
		gl.bindVertexArray(p.vao)
		gl.uniform2f(p.viewport, this.width, this.height)
		gl.uniform1f(p.dpr, this.dpr)
		gl.activeTexture(gl.TEXTURE0)
		gl.bindTexture(gl.TEXTURE_2D, this.texture)
		gl.uniform2f(p.atlas, this.atlasSize, this.atlasSize)
		for (let pass of passes) {
			if (!pass.count) continue
			if ((pass.kind == "rect") !== rect) {
				rect = pass.kind == "rect"
				gl.uniform1i(p.rect, rect ? 1 : 0)
			}
			gl.uniform2f(p.offset, pass.offsetX, pass.offsetY)
			this.upload(pass.buffer)
			let base = pass.first * pass.buffer.stride * 4, stride = STRIDE_BYTES
			gl.enableVertexAttribArray(0)
			gl.vertexAttribPointer(0, 4, gl.FLOAT, false, stride, base)
			gl.vertexAttribDivisor(0, 1)
			gl.enableVertexAttribArray(1)
			gl.vertexAttribPointer(1, 2, gl.UNSIGNED_SHORT, false, stride, base + 8)
			gl.vertexAttribDivisor(1, 1)
			gl.enableVertexAttribArray(2)
			gl.vertexAttribPointer(2, 2, gl.UNSIGNED_SHORT, false, stride, base + 12)
			gl.vertexAttribDivisor(2, 1)
			gl.enableVertexAttribArray(3)
			gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, stride, base + 16)
			gl.vertexAttribDivisor(3, 1)
			if (pass.clip) {
				let c = pass.clip, d = this.dpr
				gl.enable(gl.SCISSOR_TEST)
				let x = Math.round(c.x * d), y = Math.round(c.y * d)
				let w = Math.round((c.x + c.w) * d) - x, h = Math.round((c.y + c.h) * d) - y
				gl.scissor(x, this.height - y - h, Math.max(0, w), Math.max(0, h))
			} else {
				gl.disable(gl.SCISSOR_TEST)
			}
			gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, pass.count)
		}
	}

	destroy() {
		this.onLost = this.onRestored = null
		this.canvas.removeEventListener("webglcontextlost", this.handleLost)
		this.canvas.removeEventListener("webglcontextrestored", this.handleRestored)
		if (!this.lost) this.gl.getExtension("WEBGL_lose_context")?.loseContext()
	}
}
