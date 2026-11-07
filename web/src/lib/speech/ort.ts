import * as ort from 'onnxruntime-web'

import { configureWasm } from './wasm'

let configured = false

export function configureOrt(): void {
  if (configured) return
  configured = true
  configureWasm(ort.env.wasm)
}

export { ort }
