// Turning a segmentation mask into something a canvas can composite. The
// model gives one confidence per pixel of a small mask; the edges are
// what decide whether a blurred background looks like a bad cut-out or
// like a room out of focus, so the ramp between "person" and "not" is
// narrow enough to keep a background object from lingering as a ghost,
// and the upscale does the feathering.

/** Confidence below which a pixel is background, and above which it is person. */
export const MASK_LOW = 0.35
export const MASK_HIGH = 0.75

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

/** The input shape a segmentation model was built for. */
export type SegmentShape = 'landscape' | 'square'

/**
 * modelFor picks the model whose fixed input matches the camera's shape: a
 * picture squashed from 16:9 into a square is a person the model segments
 * worse, and a person is what this is for.
 */
export function modelFor(width: number, height: number): SegmentShape {
  return width >= height ? 'landscape' : 'square'
}

/**
 * The share of a frame's time segmentation may take before it is thinned
 * out: a mask is worth having often, but not at the cost of the picture.
 */
export const SEGMENT_BUDGET_RATIO = 0.5

/**
 * segmentCadence is how many frames apart to segment, given what one
 * segmentation costs: a machine that segments in a few milliseconds asks
 * every frame, and a slow one thins the masks out instead of the frames.
 */
export function segmentCadence(segmentMs: number, frameMs: number, budgetRatio = SEGMENT_BUDGET_RATIO): number {
  if (segmentMs <= 0) return 1

  return Math.max(1, Math.ceil(segmentMs / Math.max(1, frameMs * budgetRatio)))
}

/** The background's blur radius, as a fraction of the frame's width. */
export const BLUR_RADIUS_RATIO = 1 / 30

/**
 * How wide the fade from the person to the blurred room is, as a fraction
 * of the frame's width. A mask cut with a hard edge looks pasted on, and
 * the wider the frame the more a fixed few pixels of fade disappear.
 */
export const EDGE_FEATHER_RATIO = 1 / 160

/** The fade at the person's edge, in the frame's pixels. */
export function featherRadius(width: number): number {
  return Math.max(2, Math.round(width * EDGE_FEATHER_RATIO))
}

export interface BlurPlan {
  /** The picture's size on the canvas the blurred copy is drawn into. */
  width: number
  height: number
  /** Margin around the picture, so the blur has content past every edge. */
  pad: number
  /** Gaussian radius, in the blurred canvas's pixels. */
  radius: number
}

/**
 * blurPlan is the geometry of the blurred background: the picture drawn at
 * a fraction of the frame's size, with a margin wide enough that the blur
 * samples real picture at the edges instead of fading to nothing, and a
 * radius that looks the same at every capture resolution.
 */
export function blurPlan(
  width: number,
  height: number,
  downscale = 2,
  radiusRatio = BLUR_RADIUS_RATIO,
): BlurPlan {
  const radius = Math.max(1, Math.round((width * radiusRatio) / downscale))

  return {
    width: Math.max(1, Math.round(width / downscale)),
    height: Math.max(1, Math.round(height / downscale)),
    radius,
    pad: radius * 2,
  }
}
