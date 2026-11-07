import { env } from '@huggingface/transformers'

import { configureOnnx } from './wasm'

let configured = false

export function configureTransformers(base: string): void {
  env.allowLocalModels = true
  env.allowRemoteModels = false
  env.localModelPath = base

  if (configured) return
  configured = true

  const wasm = env.backends.onnx.wasm
  if (!wasm) throw new Error('transformers.js has no WebAssembly backend to configure')
  configureOnnx({ wasm, webgpu: env.backends.onnx.webgpu }, 'model')
}
