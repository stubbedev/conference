import * as ort from 'onnxruntime-web'

import { configureOnnx, type Runtime, type ThreadUse } from './wasm'

let configured = false

export function configureOrt(use: ThreadUse, runtime: Runtime): void {
  if (configured) return
  configured = true
  configureOnnx(ort.env, use, runtime)
}

export { ort }
