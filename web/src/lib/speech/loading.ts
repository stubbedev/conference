import { notify } from './serve'

interface ProgressInfo {
  status: string
  name?: string
  file?: string
  loaded?: number
  total?: number
}

export function reportLoading(info: ProgressInfo): void {
  if (info.status !== 'progress' || !info.file || info.total === undefined || info.loaded === undefined) return
  notify('loading', { file: `${info.name ?? ''}/${info.file}`, loaded: info.loaded, total: info.total })
}
