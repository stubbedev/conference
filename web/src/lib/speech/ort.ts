import * as ort from 'onnxruntime-web'

import { configureOnnx, type ThreadUse } from './wasm'

let configured = false

export function configureOrt(use: ThreadUse): void {
  if (configured) return
  configured = true
  configureOnnx(ort.env, use)
}

export { ort }
