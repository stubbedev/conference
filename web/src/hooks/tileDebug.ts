import { useSyncExternalStore } from 'react'

// Debug overlays show per-tile playback diagnostics: rendered and
// dropped frame counters plus element state. When a tile freezes these
// numbers say which side failed — counters still climbing means frames
// decode but the picture stopped compositing; counters frozen means
// frames stopped arriving or decrypting.
//
// Enabled by "debug=1" anywhere in the URL (the room key lives in the
// #fragment, so a trailing ?debug=1 typed after it never reaches
// location.search), or toggled at runtime by tapping the room name
// five times.
let enabled = typeof location !== 'undefined' && /debug=1/.test(location.href)
const listeners = new Set<() => void>()

export function toggleTileDebug(): void {
  enabled = !enabled
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useTileDebug(): boolean {
  return useSyncExternalStore(subscribe, () => enabled)
}
