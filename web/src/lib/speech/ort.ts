// ONNX Runtime Web as this app's own models use it: the WebAssembly files
// are served from /ort/ by the build script, never from a CDN, and the
// runtime gets one thread because the app is not cross-origin isolated and
// a threaded build would fail to start. The files are the JSEP build: it
// is the one that can load a session either on WebGPU or on the CPU, so a
// voice that cannot run on a GPU still runs here.
//
// The environment is set once, before the first session, and the settings
// stay for the life of the worker.

import * as ort from 'onnxruntime-web'

const WASM = '/ort/ort-wasm-simd-threaded.jsep.mjs'
const WASM_BINARY = '/ort/ort-wasm-simd-threaded.jsep.wasm'

let configured = false

/** Points ONNX Runtime at this app's WebAssembly files; safe to call twice. */
export function configureOrt(): void {
  if (configured) return
  configured = true

  ort.env.wasm.wasmPaths = { mjs: WASM, wasm: WASM_BINARY }
  ort.env.wasm.numThreads = 1
}

export { ort }
