import { errorMessage } from './errors.ts'

export class ChunkLoadFailed extends Error {
  constructor(what: string, cause: unknown) {
    super(`Could not load ${what}: ${errorMessage(cause)}`, { cause })
    this.name = 'ChunkLoadFailed'
  }
}

export function loadChunk<T>(what: string, load: () => Promise<T>): Promise<T> {
  return load().catch((err: unknown) => {
    throw new ChunkLoadFailed(what, err)
  })
}
