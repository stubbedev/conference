import { Unreachable } from './api.ts'
import { errorMessage } from './errors.ts'

export type RoomFailure = { kind: 'unreachable'; message: string } | { kind: 'failed'; message: string }

export function roomFailure(err: unknown): RoomFailure {
  if (err instanceof Unreachable) return { kind: 'unreachable', message: err.message }
  return { kind: 'failed', message: errorMessage(err) }
}
