import {unpackRGBA} from "./color.js"
import {GLYPH_STRIDE, RECT_STRIDE} from "./instances.js"

const shared = `
struct U { viewport: vec2f, offset: vec2f, atlas: vec2f, dpr: f32, pad: f32, clip: vec4f }
@group(0) @binding(0) var<uniform> u: U;
fn corner(vi: u32) -> vec2f { return vec2f(f32(vi & 1u), f32(vi >> 1u)); }
fn snap(p: vec2f) -> vec2f { return floor(p * u.dpr + 0.5); }
fn toClip(p: vec2f) -> vec4f {
  return vec4f(p.x / u.viewport.x * 2.0 - 1.0, 1.0 - p.y / u.viewport.y * 2.0, 0.0, 1.0);
}
fn clipped(p: vec4f) -> bool {
  return p.x < u.clip.x || p.y < u.clip.y || p.x >= u.clip.z || p.y >= u.clip.w;
}
`

const glyphWGSL = shared + `
@group(0) @binding(1) var tex: texture_2d<f32>;
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) texel: vec2u,
  @location(1) local: vec2f,
  @location(2) @interpolate(flat) color: vec4f
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) pos: vec2f,
              @location(1) uv: vec2u, @location(2) size: vec2u, @location(3) color: vec4f) -> VOut {
  let c = corner(vi);
  let s = vec2f(size);
  let origin = snap(pos) + snap(u.offset);
  var out: VOut;
  out.pos = toClip(origin + c * s);
  out.texel = uv;
  out.local = c * s;
  out.color = color;
  return out;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  if (clipped(in.pos)) { discard; }
  let t = textureLoad(tex, in.texel + vec2u(in.local), 0);
  if (in.color.a == 0.0) { return t; }
  return vec4f(in.color.rgb, 1.0) * (t.a * in.color.a);
}
`

const rectWGSL = shared + `
struct VOut { @builtin(position) pos: vec4f, @location(0) color: vec4f }
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) rect: vec4f, @location(1) color: vec4f) -> VOut {
  let c = corner(vi);
  let off = snap(u.offset);
  let a = snap(rect.xy) + off;
  let b = max(snap(rect.xy + rect.zw) + off, a + 1.0);
  var out: VOut;
  out.pos = toClip(mix(a, b, c));
  out.color = vec4f(color.rgb * color.a, color.a);
  return out;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  if (clipped(in.pos)) { discard; }
  return in.color;
}
`

const UNIFORM_SLOT = 256
const UNIFORM_FLOATS = 12
const NO_CLIP = 1e7

const blend = {
	color: {srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add"},
	alpha: {srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add"}
}

/**
 * @typedef {Object} BufferState
 * @property {GPUBuffer} buffer
 * @property {number} bytes
 */

/**
 * WebGPU render backend. Draw commands are recorded once into a render
 * bundle with indirect draws: a normal frame only writes the per-pass
 * uniforms (offsets) and instance counts, then executes the bundle.
 */
export class WebGPUBackend {
	/**
	 * Get a device: the slow, asynchronous part of setting up.
	 * @returns {Promise<GPUDevice|null>}
	 */
	static async requestDevice() {
		let gpu = globalThis.navigator?.gpu
		if (!gpu) return null
		let adapter = await gpu.requestAdapter({powerPreference: "low-power"})
		return adapter ? adapter.requestDevice() : null
	}

	/**
	 * Create a WebGPU backend, or return null when no adapter exists.
	 * @param {HTMLCanvasElement} canvas
	 * @param {Promise<GPUDevice|null>} [device]
	 * @returns {Promise<WebGPUBackend|null>}
	 */
	static async create(canvas, device = WebGPUBackend.requestDevice()) {
		let dev = await device
		return dev && new WebGPUBackend(canvas, dev, navigator.gpu.getPreferredCanvasFormat())
	}

	/**
	 * @param {HTMLCanvasElement} canvas
	 * @param {GPUDevice} device
	 * @param {string} format
	 */
	constructor(canvas, device, format) {
		/** @type {"webgpu"} */
		this.kind = "webgpu"
		/** @type {HTMLCanvasElement} */
		this.canvas = canvas
		/** @type {GPUDevice} */
		this.device = device
		/** @type {boolean} */
		this.lost = false
		/** @type {((permanent: boolean) => void)|null} */
		this.onLost = null
		/** @type {(() => void)|null} */
		this.onRestored = null
		/** @type {number} */
		this.maxTextureSize = device.limits.maxTextureDimension2D
		/** @type {boolean} */
		this.destroyed = false

		/** @type {any} */
		this.format = format
		/** @type {GPUCanvasContext} */
		this.context = /** @type {GPUCanvasContext} */ (canvas.getContext("webgpu"))
		if (!this.context) throw new Error("canvas-text: WebGPU canvas context unavailable")
		this.context.configure({device, format, alphaMode: "opaque"})

		device.lost.then(() => {
			if (this.destroyed) return
			this.lost = true
			this.onLost?.(true)
		})

		/** @type {GPUBindGroupLayout} */
		this.glyphLayout = device.createBindGroupLayout({entries: [
			{binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
				buffer: {type: "uniform", hasDynamicOffset: true, minBindingSize: UNIFORM_FLOATS * 4}},
			{binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "float"}}
		]})
		/** @type {GPUBindGroupLayout} */
		this.rectLayout = device.createBindGroupLayout({entries: [
			{binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
				buffer: {type: "uniform", hasDynamicOffset: true, minBindingSize: UNIFORM_FLOATS * 4}}
		]})

		let glyphModule = device.createShaderModule({code: glyphWGSL})
		/** @type {GPURenderPipeline} */
		this.glyphPipeline = device.createRenderPipeline({
			layout: device.createPipelineLayout({bindGroupLayouts: [this.glyphLayout]}),
			vertex: {module: glyphModule, entryPoint: "vs", buffers: [{
				arrayStride: GLYPH_STRIDE * 4, stepMode: "instance",
				attributes: [
					{shaderLocation: 0, offset: 0, format: "float32x2"},
					{shaderLocation: 1, offset: 8, format: "uint16x2"},
					{shaderLocation: 2, offset: 12, format: "uint16x2"},
					{shaderLocation: 3, offset: 16, format: "unorm8x4"}
				]
			}]},
			fragment: {module: glyphModule, entryPoint: "fs", targets: [{format, blend}]},
			primitive: {topology: "triangle-strip"}
		})
		let rectModule = device.createShaderModule({code: rectWGSL})
		/** @type {GPURenderPipeline} */
		this.rectPipeline = device.createRenderPipeline({
			layout: device.createPipelineLayout({bindGroupLayouts: [this.rectLayout]}),
			vertex: {module: rectModule, entryPoint: "vs", buffers: [{
				arrayStride: RECT_STRIDE * 4, stepMode: "instance",
				attributes: [
					{shaderLocation: 0, offset: 0, format: "float32x4"},
					{shaderLocation: 1, offset: 16, format: "unorm8x4"}
				]
			}]},
			fragment: {module: rectModule, entryPoint: "fs", targets: [{format, blend}]},
			primitive: {topology: "triangle-strip"}
		})
		/** @type {number} */
		this.slots = 0
		/** @type {Float32Array} */
		this.uniformData = new Float32Array(0)
		/** @type {Uint32Array} */
		this.indirectData = new Uint32Array(0)
		/** @type {GPUBuffer|null} */
		this.uniforms = null
		/** @type {GPUBuffer|null} */
		this.indirect = null
		/** @type {GPUBindGroup|null} */
		this.rectGroup = null
		/** @type {GPUBindGroup|null} */
		this.glyphGroup = null
		/** @type {GPURenderBundle|null} */
		this.bundle = null
		/** @type {{view: any, clearValue: {r: number, g: number, b: number, a: number}, loadOp: string, storeOp: string}} */
		this.colorAttachment = {view: null, clearValue: {r: 0, g: 0, b: 0, a: 1}, loadOp: "clear", storeOp: "store"}
		/** @type {any} */
		this.passDescriptor = {colorAttachments: [this.colorAttachment]}
		/** @type {WeakMap<import("./instances.js").InstanceBuffer, BufferState>} */
		this.buffers = new WeakMap()
		/** @type {Array<GPUBuffer|string>} */
		this.bundleKey = []
		this.allocSlots(16)
	}

	/** @param {number} slots */
	allocSlots(slots) {
		this.uniforms?.destroy()
		this.indirect?.destroy()
		this.slots = slots
		this.uniformData = new Float32Array(slots * UNIFORM_SLOT / 4)
		this.indirectData = new Uint32Array(slots * 4)
		this.indirectData.fill(0xffffffff)
		this.uniforms = this.device.createBuffer({size: slots * UNIFORM_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST})
		this.indirect = this.device.createBuffer({size: slots * 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST})
		this.rectGroup = this.device.createBindGroup({layout: this.rectLayout, entries: [
			{binding: 0, resource: {buffer: this.uniforms, size: UNIFORM_FLOATS * 4}}
		]})
		this.glyphGroup = this.makeGlyphGroup()
		this.bundle = null
	}

	/** @returns {GPUBindGroup|null} */
	makeGlyphGroup() {
		if (!this.texture) return null
		return this.device.createBindGroup({layout: this.glyphLayout, entries: [
			{binding: 0, resource: {buffer: this.uniforms, size: UNIFORM_FLOATS * 4}},
			{binding: 1, resource: this.texture.createView()}
		]})
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

	/** @param {number} size @returns {GPUTexture} */
	createTexture(size) {
		return this.device.createTexture({
			size: [size, size], format: "rgba8unorm",
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT
		})
	}

	/** @param {import("./atlas.js").GlyphAtlas} atlas */
	syncAtlas(atlas) {
		if (this.lost) return
		let tex = this.texture
		if (!tex || atlas != this.atlas || tex.width > atlas.size) {
			tex?.destroy()
			this.texture = this.createTexture(atlas.size)
			atlas.markAllDirty()
			this.onTextureChanged()
		} else if (tex.width < atlas.size) {
			let next = this.createTexture(atlas.size)
			let encoder = this.device.createCommandEncoder()
			encoder.copyTextureToTexture({texture: tex}, {texture: next}, [tex.width, tex.height])
			this.device.queue.submit([encoder.finish()])
			tex.destroy()
			this.texture = next
			this.onTextureChanged()
		}
		this.atlas = atlas
		let d = atlas.takeDirty()
		if (d && d.w > 0 && d.h > 0) {
			this.device.queue.copyExternalImageToTexture(
				{source: atlas.source, origin: {x: d.x, y: d.y}},
				{texture: this.texture, origin: {x: d.x, y: d.y}, premultipliedAlpha: true},
				{width: d.w, height: d.h})
		}
	}

	onTextureChanged() {
		this.glyphGroup = this.makeGlyphGroup()
		this.bundle = null
	}

	/** @param {import("./instances.js").InstanceBuffer} buf @returns {GPUBuffer} */
	upload(buf) {
		let state = this.buffers.get(buf)
		let from = buf.dirtyFrom
		if (!state || state.bytes < buf.byteLength) {
			state?.buffer.destroy()
			let size = Math.max(256, buf.buffer.byteLength)
			state = {buffer: this.device.createBuffer({size, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST}), bytes: size}
			this.buffers.set(buf, state)
			this.bundle = null
			from = 0
		}
		if (from < buf.count) {
			let w = buf.stride * 4
			this.device.queue.writeBuffer(state.buffer, from * w, buf.buffer, from * w, (buf.count - from) * w)
		}
		buf.markClean()
		return state.buffer
	}

	/**
	 * @param {number} background - PackedColor
	 * @param {Array<{kind: string, buffer: import("./instances.js").InstanceBuffer, first: number, count: number, offsetX: number, offsetY: number, clip?: {x: number, y: number, w: number, h: number}}>} passes
	 */
	render(background, passes) {
		if (this.lost) return
		if (passes.length > this.slots) this.allocSlots(Math.max(passes.length, this.slots * 2))
		/** @type {any} */
		let data = this.uniformData
		/** @type {any} */
		let ind = this.indirectData
		let slot = UNIFORM_SLOT / 4
		let atlasSize = this.texture?.width ?? 1
		let key = this.bundleKey, keyChanged = key.length != passes.length * 2, countsChanged = false
		for (let i = 0; i < passes.length; i++) {
			let p = passes[i]
			let gpuBuffer = this.upload(p.buffer)
			if (key[i * 2] !== gpuBuffer || key[i * 2 + 1] !== p.kind) keyChanged = true
			key[i * 2] = gpuBuffer
			key[i * 2 + 1] = p.kind
			let o = i * slot
			data.set([this.width, this.height, p.offsetX, p.offsetY, atlasSize, atlasSize, this.dpr], o)
			let c = p.clip
			if (c) {
				let cx = c.x, cy = c.y, cw = c.w, ch = c.h
				// @ts-expect-error clip values are defined
				data.set([Math.round(cx * this.dpr), Math.round(cy * this.dpr), Math.round((cx + cw) * this.dpr), Math.round((cy + ch) * this.dpr)], o + 8)
			} else {
				data.set([-NO_CLIP, -NO_CLIP, NO_CLIP, NO_CLIP], o + 8)
			}
			let count = p.kind == "glyph" && !this.glyphGroup ? 0 : p.count
			if (ind[i * 4 + 1] != count || ind[i * 4] != 4) {
				ind[i * 4] = 4
				ind[i * 4 + 1] = count
				ind[i * 4 + 2] = 0
				ind[i * 4 + 3] = 0
				countsChanged = true
			}
			if (p.first != 0) throw new RangeError("canvas-text: WebGPU passes must start at instance 0")
		}
		key.length = passes.length * 2
		let queue = this.device.queue
		if (!this.uniforms || !this.indirect) throw new Error("canvas-text: buffers not allocated")
		queue.writeBuffer(this.uniforms, 0, data.buffer, 0, passes.length * UNIFORM_SLOT)
		if (countsChanged) queue.writeBuffer(this.indirect, 0, ind.buffer, 0, passes.length * 16)
		if (keyChanged || !this.bundle) this.bundle = this.record(passes)

		let [r, g, b] = unpackRGBA(background)
		/** @type {{r: number, g: number, b: number, a: number}} */
		let clear = this.colorAttachment.clearValue
		clear.r = r / 255; clear.g = g / 255; clear.b = b / 255
		this.colorAttachment.view = this.context.getCurrentTexture().createView()
		let encoder = this.device.createCommandEncoder()
		let pass = encoder.beginRenderPass(this.passDescriptor)
		pass.executeBundles([this.bundle])
		pass.end()
		queue.submit([encoder.finish()])
	}

	/** @param {Array<{kind: string, buffer: import("./instances.js").InstanceBuffer, first: number, count: number, offsetX: number, offsetY: number, clip?: {x: number, y: number, w: number, h: number}}>} passes @returns {GPURenderBundle} */
	record(passes) {
		let enc = this.device.createRenderBundleEncoder({colorFormats: [this.format]})
		let current = null
		for (let i = 0; i < passes.length; i++) {
			let p = passes[i]
			let glyph = p.kind == "glyph"
			if (glyph && !this.glyphGroup) continue
			let pipeline = glyph ? this.glyphPipeline : this.rectPipeline
			if (pipeline != current) enc.setPipeline(current = pipeline)
			enc.setBindGroup(0, glyph ? this.glyphGroup : this.rectGroup, [i * UNIFORM_SLOT])
			let state = this.buffers.get(p.buffer)
			if (!state) throw new Error("canvas-text: buffer not uploaded")
			enc.setVertexBuffer(0, state.buffer)
			if (!this.indirect) throw new Error("canvas-text: indirect buffer not allocated")
			enc.drawIndirect(this.indirect, i * 16)
		}
		return enc.finish()
	}

	destroy() {
		this.destroyed = true
		this.onLost = this.onRestored = null
		this.texture?.destroy()
		this.uniforms?.destroy()
		this.indirect?.destroy()
		this.context.unconfigure()
		this.device.destroy()
	}
}
