// transformers.js pointed at the models this server serves and at nothing
// else: a member's speech is never sent to a model hub at call time, so
// only the local base path is allowed and the hub is refused. The
// WebAssembly files come from /ort/ like every other runtime in the app,
// and the runtime gets one thread because the app is not cross-origin
// isolated. The build used here is the asyncify one, which transformers.js
// itself uses beside a GPU.

import { env } from '@huggingface/transformers'

const WASM = '/ort/ort-wasm-simd-threaded.jsep.mjs'
const WASM_BINARY = '/ort/ort-wasm-simd-threaded.jsep.wasm'

let configured = false

/** Points transformers.js at base and at this app's WebAssembly files. */
export function configureTransformers(base: string): void {
  env.allowLocalModels = true
  env.allowRemoteModels = false
  env.localModelPath = base

  if (configured) return
  configured = true

  const wasm = env.backends.onnx.wasm
  if (!wasm) return

  wasm.wasmPaths = { mjs: WASM, wasm: WASM_BINARY }
  wasm.numThreads = 1
}
