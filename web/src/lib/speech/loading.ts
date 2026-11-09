import { browserFetchDeps, headFirstFetch, resilientFetch } from './fetching'
import { message } from './runtime'
import { notify } from './serve'

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

export function reportWarning(warning: string): void {
  notify('warning', { message: warning })
}

export function webgpuFailed(err: unknown, instead: string): false {
  reportWarning(`WebGPU failed (${message(err)}), so ${instead}.`)
  return false
}

export function fetchRetrying(url: string, init: RequestInit = {}): Promise<Response> {
  return resilientFetch(url, init, deps)
}

export function fetchHeadFirst(url: string, init: RequestInit = {}): Promise<Response> {
  return headFirstFetch(url, init, deps)
}
