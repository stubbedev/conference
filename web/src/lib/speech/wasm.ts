import { readBody, resilientFetch, type FetchDeps } from './fetching.ts'

export const WASM_PATHS = {
  mjs: '/ort/ort-wasm-simd-threaded.asyncify.mjs',
  wasm: '/ort/ort-wasm-simd-threaded.asyncify.wasm',
}

const MAX_THREADS = 4

const WORKERS = 4

export type ThreadUse = 'model' | 'detector'

export interface Runtime {
  wasm: ArrayBuffer
  factory: string
}

export function parseRuntime(value: unknown): Runtime {
  const runtime = value as Partial<Runtime> | null | undefined
  if (!(runtime?.wasm instanceof ArrayBuffer) || typeof runtime.factory !== 'string') {
    throw new Error('the speech worker was started without the speech runtime: init needs runtime.wasm (ArrayBuffer) and runtime.factory (string)')
  }
  return { wasm: runtime.wasm, factory: runtime.factory }
}

export function wasmThreads(isolated: boolean, cores: number, use: ThreadUse): number {
  if (!isolated || use === 'detector') return 1
  return Math.max(1, Math.min(MAX_THREADS, Math.floor(cores / WORKERS)))
}

async function fetchRuntimeFile(url: string, deps: FetchDeps, onProgress: (loaded: number, total: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  const response = await resilientFetch(url, {}, deps)
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`the speech runtime ${url} could not be fetched: ${response.status} ${response.statusText}`)
  }
  return readBody(response, onProgress)
}

export async function fetchRuntime(deps: FetchDeps, onProgress: (file: string, loaded: number, total: number) => void): Promise<Runtime> {
  const [wasm, factory] = await Promise.all(
    [WASM_PATHS.wasm, WASM_PATHS.mjs].map((url) => fetchRuntimeFile(url, deps, (loaded, total) => onProgress(url, loaded, total))),
  )
  return { wasm: wasm.buffer, factory: new TextDecoder().decode(factory) }
}

interface OnnxFlags {
  wasm: { wasmPaths?: unknown; wasmBinary?: ArrayBufferLike | Uint8Array; numThreads?: number }
  webgpu?: { powerPreference?: 'low-power' | 'high-performance' }
}

export function configureOnnx(flags: OnnxFlags, use: ThreadUse, runtime: Runtime): void {
  flags.wasm.wasmBinary = runtime.wasm
  flags.wasm.wasmPaths = { mjs: URL.createObjectURL(new Blob([runtime.factory], { type: 'text/javascript' })) }
  flags.wasm.numThreads = wasmThreads(globalThis.crossOriginIsolated === true, navigator.hardwareConcurrency ?? 1, use)
  if (flags.webgpu) flags.webgpu.powerPreference = 'high-performance'
}
