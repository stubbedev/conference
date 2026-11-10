export const FIRST_GPU_BUDGET_MS = 60_000
export const MIN_GPU_BUDGET_MS = 10_000
export const GPU_BUDGET_FACTOR = 4

export interface GpuHistory<P extends string> {
  readonly setup: string
  readonly quietMs: Readonly<Partial<Record<P, number>>>
  readonly unusable: readonly P[]
}

export function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function freshHistory<P extends string>(setup: string): GpuHistory<P> {
  const quietMs: Partial<Record<P, number>> = {}
  return { setup, quietMs, unusable: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseHistory<P extends string>(stored: string | null, setup: string, purposes: readonly P[]): GpuHistory<P> {
  if (stored === null) return freshHistory(setup)

  const value: unknown = JSON.parse(stored)
  if (!isRecord(value) || value.setup !== setup || !isRecord(value.quietMs) || !Array.isArray(value.unusable)) return freshHistory(setup)

  const quiet = value.quietMs
  const quietMs: Partial<Record<P, number>> = {}
  for (const purpose of purposes) {
    const ms = quiet[purpose]
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) quietMs[purpose] = ms
  }
  const unusable = purposes.filter((purpose) => (value.unusable as unknown[]).includes(purpose))
  return { setup, quietMs, unusable }
}

export function budgetFor<P extends string>(history: GpuHistory<P>, purpose: P): number {
  const quiet = history.quietMs[purpose]
  if (quiet === undefined) return FIRST_GPU_BUDGET_MS
  return Math.min(Math.max(quiet * GPU_BUDGET_FACTOR, MIN_GPU_BUDGET_MS), FIRST_GPU_BUDGET_MS)
}

export function withQuiet<P extends string>(history: GpuHistory<P>, purpose: P, ms: number): GpuHistory<P> {
  const known = history.quietMs[purpose]
  if (known !== undefined && known >= ms) return history
  return { ...history, quietMs: { ...history.quietMs, [purpose]: ms } }
}

export function withUnusable<P extends string>(history: GpuHistory<P>, purpose: P): GpuHistory<P> {
  if (history.unusable.includes(purpose)) return history
  return { ...history, unusable: [...history.unusable, purpose] }
}
