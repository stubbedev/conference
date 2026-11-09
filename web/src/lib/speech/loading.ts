import { browserFetchDeps, headFirstFetch, resilientFetch } from './fetching'
import { message, type Capabilities, type Rung } from './runtime'
import { notify } from './serve'
import { webgpuAvailable, webgpuHalves } from './webgpu'

interface ProgressInfo {
  status: string
  name?: string
  file?: string
  loaded?: number
  total?: number
}

const deps = browserFetchDeps((retrying) => notify('retrying', { ...retrying }))

export function expectLoading(key: string): void {
  notify('expect', { key })
}

export function reportLoading(info: ProgressInfo): void {
  if (info.status !== 'progress' || !info.file || info.total === undefined || info.loaded === undefined) return
  notify('loading', { file: `${info.name ?? ''}/${info.file}`, loaded: info.loaded, total: info.total })
}

export async function attemptingGpu<T>(work: () => Promise<T>): Promise<T> {
  notify('gpu-started', {})
  try {
    return await work()
  } finally {
    notify('gpu-settled', {})
  }
}

export function attempting<T>(rung: Rung, work: () => Promise<T>): Promise<T> {
  return rung.device === 'webgpu' ? attemptingGpu(work) : work()
}

export function reportWarning(warning: string): void {
  notify('warning', { message: warning })
}

export function webgpuFailed(err: unknown, instead: string): false {
  reportWarning(`WebGPU failed (${message(err)}), so ${instead}.`)
  return false
}

export function gpuCapabilities(what: string): Promise<Capabilities> {
  return attemptingGpu(async () => {
    const gpu = await webgpuAvailable().catch((err: unknown) => webgpuFailed(err, `${what} runs on the CPU`))
    if (!gpu) return { gpu, halves: false }
    return { gpu, halves: await webgpuHalves().catch((err: unknown) => webgpuFailed(err, `${what} runs without 16-bit floats`)) }
  })
}

export function reportRefused(what: string, model: string, rung: Rung, err: unknown): void {
  reportWarning(`The ${what} model ${model} could not run as ${rung.dtype} on the ${rung.device === 'webgpu' ? 'GPU' : 'CPU'}: ${message(err)}`)
}

export function fetchRetrying(url: string, init: RequestInit = {}): Promise<Response> {
  return resilientFetch(url, init, deps)
}

export function fetchHeadFirst(url: string, init: RequestInit = {}): Promise<Response> {
  return headFirstFetch(url, init, deps)
}
