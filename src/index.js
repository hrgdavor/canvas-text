// Default entry: both backends, WebGPU preferred with a WebGL2 fallback.
// Import "canvas-text/webgl2" or "canvas-text/webgpu" for a build that
// contains only one of them.
export * from "./api.js"
export {CanvasText} from "./entries/auto.js"
export {WebGL2Backend} from "./webgl2.js"
export {WebGPUBackend} from "./webgpu.js"
