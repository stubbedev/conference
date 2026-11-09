import { env } from '@huggingface/transformers'

import { fetchRetrying } from './loading'
import { message } from './runtime'
import { configureOnnx, type Runtime } from './wasm'

const NOT_FOUND = 404

const unfetched = new Map<string, Error>()

let configured = false

async function fetchModelFile(input: string | URL, init?: RequestInit): Promise<Response> {
  const url = String(input)
  try {
    const response = await fetchRetrying(url, init)
    if (!response.ok && response.status !== NOT_FOUND) {
      await response.body?.cancel()
      throw new Error(`fetching ${url} failed: ${response.status} ${response.statusText}`)
    }
    unfetched.delete(url)
    return response
  } catch (err) {
    unfetched.set(url, err instanceof Error ? err : new Error(message(err)))
    throw err
  }
}

export function configureTransformers(base: string, runtime: Runtime): void {
  env.allowLocalModels = true
  env.allowRemoteModels = false
  env.localModelPath = base

  if (configured) return
  configured = true

  env.useWasmCache = false
  env.fetch = fetchModelFile
  const wasm = env.backends.onnx.wasm
  if (!wasm) throw new Error('transformers.js has no WebAssembly backend to configure')
  configureOnnx({ wasm, webgpu: env.backends.onnx.webgpu }, 'model', runtime)
}

function firstUnfetched(): Error | undefined {
  return unfetched.values().next().value
}

export async function loadingModel<T>(load: () => Promise<T>): Promise<T> {
  unfetched.clear()
  let loaded: T
  try {
    loaded = await load()
  } catch (err) {
    throw firstUnfetched() ?? err
  }
  const failure = firstUnfetched()
  if (failure) throw failure
  return loaded
}
