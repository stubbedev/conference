// Quality adaptation on the viewer's side. The SFU moves a viewer between
// layers from the receiver reports it receives, which means the viewer has
// already seen the picture stall by the time the report arrives. The page
// can see its own decoder: frames it had to drop and packets that never
// arrived show up in its statistics first, so it lowers the ceiling on the
// layers it asks for before the stall is visible, and raises it again once
// the stream is clean.

export type Layer = 'l' | 'm' | 'h'

const LAYERS: readonly Layer[] = ['l', 'm', 'h']

/** Dropped decoder frames in one sample that mean the stream is too big. */
const DROPPED_FRAMES_LIMIT = 3

/** Packets lost in one sample that mean the same. */
const LOST_PACKETS_LIMIT = 20

/** Clean samples in a row before one layer is added back. */
const RECOVER_SAMPLES = 3

const MAX_RECOVER_SAMPLES = 24

const FAILED_RECOVERY_SAMPLES = 5

const SETTLED_SAMPLES = 30

export interface InboundCounters {
 /** Frames this viewer's decoder dropped, cumulatively. */
 droppedFrames: number
 /** Video packets lost, cumulatively. */
 lostPackets: number
}

export interface QualityState {
  /** The highest layer this viewer asks for, given what it has measured. */
  ceiling: Layer
  /** Consecutive samples without trouble, towards adding a layer back. */
  clean: number
  wait: number
  sinceUp: number
}

export function newQualityState(layout: Layer): QualityState {
  return { ceiling: layout, clean: 0, wait: RECOVER_SAMPLES, sinceUp: SETTLED_SAMPLES }
}

export function layerIndex(layer: Layer): number {
  return LAYERS.indexOf(layer)
}

export function lowerLayer(a: Layer, b: Layer): Layer {
  return layerIndex(a) <= layerIndex(b) ? a : b
}

function step(layer: Layer, by: number): Layer {
  const index = Math.min(LAYERS.length - 1, Math.max(0, layerIndex(layer) + by))

  return LAYERS[index] ?? 'l'
}

function troubled(health: InboundCounters): boolean {
  return health.droppedFrames >= DROPPED_FRAMES_LIMIT || health.lostPackets >= LOST_PACKETS_LIMIT
}

/**
 * nextQuality moves the viewer's ceiling one step for one sample. Trouble
 * lowers it at once; a run of clean samples raises it back towards the
 * layer the tile's size on screen can use, so a blip costs a second of
 * sharpness rather than the rest of the call.
 */
export function nextQuality(state: QualityState, layout: Layer, health: InboundCounters): QualityState {
  const sinceUp = Math.min(state.sinceUp + 1, SETTLED_SAMPLES)
  const settledWait = sinceUp >= SETTLED_SAMPLES ? RECOVER_SAMPLES : state.wait

  if (troubled(health)) {
    const failed = state.sinceUp < FAILED_RECOVERY_SAMPLES
    return {
      ceiling: step(lowerLayer(state.ceiling, layout), -1),
      clean: 0,
      wait: failed ? Math.min(state.wait * 2, MAX_RECOVER_SAMPLES) : settledWait,
      sinceUp,
    }
  }

  if (layerIndex(state.ceiling) >= layerIndex(layout)) {
    return { ceiling: layout, clean: 0, wait: settledWait, sinceUp }
  }

  const clean = state.clean + 1
  if (clean < settledWait) {
    return { ceiling: state.ceiling, clean, wait: settledWait, sinceUp }
  }

  return { ceiling: step(state.ceiling, 1), clean: 0, wait: settledWait, sinceUp: 0 }
}

/** The layer to ask for: what the layout wants, no more than the viewer can carry. */
export function preferredLayer(layout: Layer, ceiling: Layer): Layer {
  return lowerLayer(layout, ceiling)
}

/** Difference between two cumulative counters, never negative. */
export function since(previous: number, current: number): number {
  return Math.max(0, current - previous)
}
