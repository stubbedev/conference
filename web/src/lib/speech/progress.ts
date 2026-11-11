import { LOADING_PARTS, type LoadingPart, type LoadingRetry, type PartLoading } from '../translate/types.ts'

interface FileProgress {
  loaded: number
  total: number
}

interface PartState {
  expected: Map<string, number>
  files: Map<string, FileProgress>
  retry: LoadingRetry | null
  pending: number
  settled: 'loaded' | 'failed' | null
}

function emptyPart(): PartState {
  return { expected: new Map(), files: new Map(), retry: null, pending: 0, settled: null }
}

function incomplete(part: PartState): boolean {
  return part.settled === null && [...part.files.values()].some((file) => file.loaded < file.total)
}

function shown(part: LoadingPart, state: PartState): PartLoading {
  let loaded = 0
  let reported = 0
  for (const file of state.files.values()) {
    loaded += file.loaded
    reported += file.total
  }
  let expected = 0
  for (const bytes of state.expected.values()) expected += bytes
  const total = expected > 0 ? expected : reported
  return { part, loaded: state.settled === 'loaded' ? total : Math.min(loaded, total), total, retry: state.retry }
}

export function overall(parts: readonly PartLoading[]): { loaded: number; total: number } {
  let loaded = 0
  let total = 0
  for (const part of parts) {
    loaded += part.loaded
    total += part.total
  }
  return { loaded, total }
}

export class Progress {
  private readonly parts = new Map<LoadingPart, PartState>()

  begin(part: LoadingPart): void {
    const state = this.part(part)
    state.pending += 1
    state.settled = null
  }

  end(part: LoadingPart, succeeded: boolean): void {
    const state = this.part(part)
    state.pending = Math.max(state.pending - 1, 0)
    state.retry = null
    if (state.pending === 0) state.settled = succeeded ? 'loaded' : 'failed'
  }

  expect(part: LoadingPart, model: string, bytes: number): void {
    this.part(part).expected.set(model, bytes)
  }

  file(part: LoadingPart, file: string, loaded: number, total: number): void {
    const state = this.part(part)
    state.files.set(file, { loaded, total })
    state.retry = null
  }

  retrying(part: LoadingPart, retry: LoadingRetry): void {
    this.part(part).retry = retry
  }

  snapshot(): PartLoading[] | null {
    const active = [...this.parts.values()].some((state) => state.pending > 0 || incomplete(state))
    if (!active) return null
    return LOADING_PARTS.flatMap((part) => {
      const state = this.parts.get(part)
      return state ? [shown(part, state)] : []
    })
  }

  clear(): void {
    this.parts.clear()
  }

  private part(part: LoadingPart): PartState {
    const known = this.parts.get(part)
    if (known) return known
    const state = emptyPart()
    this.parts.set(part, state)
    return state
  }
}
