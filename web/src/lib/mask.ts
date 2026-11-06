// Turning a segmentation mask into something a canvas can composite. The
// model gives one confidence per pixel of a small mask; the edges are
// what decide whether a blurred background looks like a bad cut-out or
// like a room out of focus, so the ramp between "person" and "not" is
// deliberately wide and smooth.

/** Confidence below which a pixel is background, and above which it is person. */
export const MASK_LOW = 0.3
export const MASK_HIGH = 0.7

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - low) / (high - low)))

  return t * t * (3 - 2 * t)
}

/**
 * writeMaskAlpha fills out with RGBA bytes for the given confidences: white
 * with the person's opacity, so drawing it with 'destination-in' keeps
 * exactly the person and feathers the edge.
 */
export function writeMaskAlpha(
  confidence: ArrayLike<number>,
  out: Uint8ClampedArray,
  low = MASK_LOW,
  high = MASK_HIGH,
): void {
  for (let index = 0; index < confidence.length; index += 1) {
    const alpha = Math.round(smoothstep(low, high, confidence[index] ?? 0) * 255)
    const at = index * 4
    out[at] = 255
    out[at + 1] = 255
    out[at + 2] = 255
    out[at + 3] = alpha
  }
}

/**
 * maskAlpha turns confidences into a fresh RGBA buffer a canvas can draw:
 * white with the person's opacity.
 */
export function maskAlpha(confidence: ArrayLike<number>, low = MASK_LOW, high = MASK_HIGH): Uint8ClampedArray<ArrayBuffer> {
  const bytes = new Uint8ClampedArray(confidence.length * 4)
  writeMaskAlpha(confidence, bytes, low, high)

  return bytes
}

/** How often the model is asked, out of every rendered frame. */
export function segmentEvery(fps: number, segmentFps: number): number {
  if (segmentFps <= 0) return Number.MAX_SAFE_INTEGER

  return Math.max(1, Math.round(fps / segmentFps))
}
