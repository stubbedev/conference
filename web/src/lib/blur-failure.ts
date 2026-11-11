import { ChunkLoadFailed } from './chunks.ts'

export function blurFailureMessage(err: unknown): string {
  if (err instanceof ChunkLoadFailed) return 'Could not load background blur, so your camera goes out as it is. Reload the page to try again.'
  return 'Background blur is unavailable here, so your camera goes out as it is.'
}
