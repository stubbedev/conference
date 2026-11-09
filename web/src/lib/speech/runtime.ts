export type Device = 'webgpu' | 'wasm'

export interface Capabilities {
  gpu: boolean
  halves: boolean
}

export interface Rung {
  device: Device
  dtype: string
}

export const CPU_DTYPE = 'q8'

export const GPU_LADDER: readonly string[] = ['q4f16', 'q4', 'fp16', 'fp32']

const NEEDS_HALVES: ReadonlySet<string> =new Set(['fp16', 'q4f16', 'q2f16', 'q1f16'])

const REFUSED_ON_DEVICE = /Unsupported device|does not support fp16/

export function needsHalves(dtype: string): boolean {
  return NEEDS_HALVES.has(dtype)
}

export function rungsFor(preferred: string, capabilities: Capabilities, hosted: (dtype: string) => boolean, cpu: boolean): Rung[] {
  const gpu = capabilities.gpu ? [...new Set([preferred, ...GPU_LADDER])].filter((dtype) => hosted(dtype) && (capabilities.halves || !needsHalves(dtype))) : []
  const onGpu = gpu.map((dtype): Rung => ({ device: 'webgpu', dtype }))
  return cpu && hosted(CPU_DTYPE) ? [...onGpu, { device: 'wasm', dtype: CPU_DTYPE }] : onGpu
}

export class DownloadFailed extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause })
  }
}

export async function firstThatRuns<R, T>(rungs: readonly R[], attempt: (rung: R) => Promise<T>, refused: (rung: R, err: unknown) => void): Promise<T> {
  let last: unknown = new Error('this browser can run none of the exports the server hosts')
  for (const rung of rungs) {
    try {
      return await attempt(rung)
    } catch (err) {
      if (err instanceof DownloadFailed) throw err
      refused(rung, err)
      last = err
    }
  }
  throw last
}

export function fallbackToWasm(err: unknown): boolean {
  return REFUSED_ON_DEVICE.test(message(err))
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
