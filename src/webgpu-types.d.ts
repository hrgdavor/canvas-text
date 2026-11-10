// Minimal WebGPU type declarations for type-checking.
// These are not runtime values; they exist only for tsc --noEmit.

interface GPUDevice {
	createBuffer(descriptor: {size: number, usage: number, mappedAtCreation?: boolean}): GPUBuffer
	createTexture(descriptor: {size: [number, number], format: string, usage: number}): GPUTexture
	createShaderModule(descriptor: {code: string}): GPUShaderModule
	createRenderPipeline(descriptor: any): GPURenderPipeline
	createBindGroupLayout(entries: any[]): GPUBindGroupLayout
	createPipelineLayout(descriptor: {bindGroupLayouts: GPUBindGroupLayout[]}): GPUPipelineLayout
	createBindGroup(descriptor: {layout: GPUBindGroupLayout, entries: any[]}): GPUBindGroup
	createCommandEncoder(): GPUCommandEncoder
	createRenderBundleEncoder(descriptor: {colorFormats: string[]}): GPURenderBundleEncoder
	queue: GPUQueue
	limits: {maxTextureDimension2D: number}
	destroy(): void
	lost: Promise<{reason: string}>
}

interface GPUBuffer {
	destroy(): void
}

interface GPUTexture {
	width: number
	height: number
	destroy(): void
	createView(): GPUTextureView
}

interface GPUTextureView {}

interface GPUShaderModule {}
interface GPURenderPipeline {}
interface GPUBindGroupLayout {}
interface GPUPipelineLayout {}
interface GPUBindGroup {}

interface GPUQueue {
	writeBuffer(buffer: GPUBuffer, offset: number, data: ArrayBufferView, size?: number): void
	copyExternalImageToTexture(source: any, target: any, extent: {width: number, height: number}): void
	submit(commandBuffers: GPUCommandBuffer[]): void
}

interface GPUCommandEncoder {
	copyTextureToTexture(source: any, target: any, extent: [number, number]): void
	beginRenderPass(descriptor: any): GPURenderPassEncoder
	finish(): GPUCommandBuffer
}

interface GPUCommandBuffer {}

interface GPURenderPassEncoder {
	executeBundles(bundles: GPURenderBundle[]): void
	end(): void
}

interface GPURenderBundle {}

interface GPURenderBundleEncoder {
	setPipeline(pipeline: GPURenderPipeline): void
	setBindGroup(index: number, bindGroup: GPUBindGroup | null, dynamicOffsets?: number[]): void
	setVertexBuffer(index: number, buffer: GPUBuffer): void
	drawIndirect(indirectBuffer: GPUBuffer, indirectOffset: number): void
	finish(): GPURenderBundle
}

interface GPUCanvasContext {
	configure(descriptor: {device: GPUDevice, format: string, alphaMode: string}): void
	unconfigure(): void
	getCurrentTexture(): GPUTexture
}

interface GPUAdapter {
	requestDevice(): Promise<GPUDevice>
}

interface GPU {
	requestAdapter(options?: any): Promise<GPUAdapter | null>
	getPreferredCanvasFormat(): string
}

declare const GPUBufferUsage: {
	VERTEX: number
	UNIFORM: number
	COPY_DST: number
	INDIRECT: number
}

declare const GPUTextureUsage: {
	TEXTURE_BINDING: number
	COPY_DST: number
	COPY_SRC: number
	RENDER_ATTACHMENT: number
}

declare const GPUShaderStage: {
	VERTEX: number
	FRAGMENT: number
}
