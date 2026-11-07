export const WASM_PATHS = {
  mjs: '/ort/ort-wasm-simd-threaded.asyncify.mjs',
  wasm: '/ort/ort-wasm-simd-threaded.asyncify.wasm',
}

const MAX_THREADS = 4

const WORKERS = 4

export type ThreadUse = 'model' | 'detector'

export function wasmThreads(isolated: boolean, cores: number, use: ThreadUse): number {
  if (!isolated || use === 'detector') return 1
  return Math.max(1, Math.min(MAX_THREADS, Math.floor(cores / WORKERS)))
}

interface OnnxFlags {
  wasm: { wasmPaths?: unknown; numThreads?: number }
  webgpu?: { powerPreference?: 'low-power' | 'high-performance' }
}

export function configureOnnx(flags: OnnxFlags, use: ThreadUse): void {
  flags.wasm.wasmPaths = WASM_PATHS
  flags.wasm.numThreads = wasmThreads(globalThis.crossOriginIsolated === true, navigator.hardwareConcurrency ?? 1, use)
  if (flags.webgpu) flags.webgpu.powerPreference = 'high-performance'
}
