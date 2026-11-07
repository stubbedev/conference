export const WASM_PATHS = {
  mjs: '/ort/ort-wasm-simd-threaded.jsep.mjs',
  wasm: '/ort/ort-wasm-simd-threaded.jsep.wasm',
}

const MAX_THREADS = 4

export function wasmThreads(isolated: boolean, cores: number): number {
  if (!isolated) return 1
  return Math.max(1, Math.min(MAX_THREADS, Math.floor(cores / 2)))
}

interface WasmFlags {
  wasmPaths?: unknown
  numThreads?: number
}

export function configureWasm(flags: WasmFlags): void {
  flags.wasmPaths = WASM_PATHS
  flags.numThreads = wasmThreads(globalThis.crossOriginIsolated === true, navigator.hardwareConcurrency ?? 1)
}
