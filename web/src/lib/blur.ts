// Background blur: the camera's own frames, segmented by the model in
// vision.ts and composited here over a blurred copy of themselves. The
// result is a canvas track carrying the camera's picture, so everything
// downstream — simulcast layers, the room, a local recording — follows
// without knowing that blur exists.
//
// The composite runs at the capture's frame rate and the model is asked as
// often as the machine can afford within a budget, measured rather than
// guessed: a mask is worth having on every frame, but never at the cost of
// the picture that carries it.

import {
  blurPlan,
  featherRadius,
  modelFor,
  segmentCadence,
  writeMaskAlpha,
  type SegmentShape,
} from '@/lib/mask'
import type { Mask, Segmenter } from '@/lib/vision'

/** How many frames a second the blurred camera publishes. */
const FPS = 30

/** The model's input is this many pixels across, whatever the camera gives. */
const SEGMENT_LONG_EDGE = 256

/** How much a new measurement moves the estimate of what a mask costs. */
const SEGMENT_SMOOTHING = 0.3

/**
 * The background is blurred at this fraction of the frame's size: a
 * Gaussian that large costs real time per pixel, and a fraction of it
 * still reads as a room out of focus once it is scaled back up.
 */
const BLUR_DOWNSCALE = 2

/**
 * How far a plain bilinear upscale has to shrink the background instead,
 * for browsers that cannot draw with a filter: the picture is drawn this
 * much smaller and scaled back up, which is the coarse version of the
 * same idea.
 */
const FILTERLESS_DOWNSCALE = 8

export interface BlurOptions {
  /** Called once when the model cannot start at all on this machine. */
  onUnavailable?: (err: unknown) => void
}

export interface BlurPipeline {
  /** The track to publish instead of the camera's own. */
  readonly track: MediaStreamTrack
  /** Points the pipeline at a new camera capture, after a device switch. */
  rewire(source: MediaStreamTrack): void
  stop(): void
}

function context(element: HTMLCanvasElement, alpha: boolean): CanvasRenderingContext2D {
  const ctx = element.getContext('2d', { alpha })
  if (!ctx) throw new Error('this browser cannot composite a blurred camera')

  return ctx
}

class CanvasBlur implements BlurPipeline {
  readonly track: MediaStreamTrack

  private readonly video = document.createElement('video')
  private readonly output = document.createElement('canvas')
  private readonly background = document.createElement('canvas')
  private readonly subject = document.createElement('canvas')
  private readonly segmentInput = document.createElement('canvas')
  private readonly maskCanvas = document.createElement('canvas')
  private readonly outputCtx = context(this.output, false)
  private readonly backgroundCtx = context(this.background, false)
  private readonly subjectCtx = context(this.subject, true)
  private readonly segmentCtx = context(this.segmentInput, false)
  private readonly maskCtx = context(this.maskCanvas, true)
  private readonly options: BlurOptions
  private readonly stream: MediaStream
  private readonly canFilter: boolean
  private plan = blurPlan(1, 1)
  private segmenter: Segmenter | null = null
  private segmentShape: SegmentShape | null = null
  private segmentRequested: SegmentShape | null = null
  private segmentMs = 0
  private frames = 0
  private mask: Mask | null = null
  private maskImage: ImageData | null = null
  private frameRequest = 0
  private timer = 0
  private stopped = false

  constructor(source: MediaStreamTrack, options: BlurOptions) {
    this.options = options
    this.canFilter = 'filter' in this.backgroundCtx

    this.video.muted = true
    this.video.playsInline = true
    this.video.srcObject = new MediaStream([source])
    void this.video.play().catch(() => {})

    this.stream = this.output.captureStream(FPS)
    const [track] = this.stream.getVideoTracks()
    if (!track) throw new Error('this browser cannot publish a composited camera')
    this.track = track

    this.schedule()
  }

  rewire(source: MediaStreamTrack): void {
    this.video.srcObject = new MediaStream([source])
    void this.video.play().catch(() => {})
  }

  stop(): void {
    this.stopped = true
    if (this.frameRequest) this.video.cancelVideoFrameCallback(this.frameRequest)

    this.frameRequest = 0
    window.clearTimeout(this.timer)
    this.timer = 0
    this.video.pause()
    this.video.srcObject = null
    for (const track of this.stream.getTracks()) track.stop()
  }

  private schedule(): void {
    if (this.stopped) return

    if (typeof this.video.requestVideoFrameCallback === 'function') {
      this.frameRequest = this.video.requestVideoFrameCallback(this.tick)

      return
    }

    this.timer = window.setTimeout(this.tick, 1000 / FPS)
  }

  private readonly tick = (): void => {
    if (this.stopped) return

    try {
      this.paint()
    } catch (err) {
      console.warn('blur: compositing a camera frame', err)
    }

    this.schedule()
  }

  private paint(): void {
    const width = this.video.videoWidth
    const height = this.video.videoHeight
    if (width === 0 || height === 0) return

    this.resize(width, height)

    const shape = modelFor(width, height)
    if (this.segmentShape !== shape) this.useModel(shape)

    if (this.segmenter && this.segmentShape === shape) this.segmentIfDue(width, height)
    this.frames += 1

    if (!this.mask) {
      this.outputCtx.drawImage(this.video, 0, 0, width, height)

      return
    }

    this.paintBackground(width, height)
    this.paintSubject(width, height)
    this.outputCtx.drawImage(this.subject, 0, 0)
  }

  private useModel(shape: SegmentShape): void {
    this.mask = null
    if (this.segmentRequested === shape) return

    this.segmentRequested = shape
    void loadSegmenterFor(shape).then(
      (segmenter) => {
        if (this.stopped) return

        this.segmenter = segmenter
        this.segmentShape = shape
        this.segmentRequested = null
      },
      (err: unknown) => {
        this.segmentRequested = null
        if (this.stopped) return

        this.options.onUnavailable?.(err)
      },
    )
  }

  private segmentIfDue(width: number, height: number): void {
    const cadence = segmentCadence(this.segmentMs, 1000 / FPS)
    if (this.frames % cadence !== 0) return

    const started = performance.now()
    this.mask = this.segment(width, height)
    const took = performance.now() - started

    this.segmentMs = this.segmentMs === 0 ? took : this.segmentMs * (1 - SEGMENT_SMOOTHING) + took * SEGMENT_SMOOTHING
  }

  private segment(width: number, height: number): Mask | null {
    const scale = SEGMENT_LONG_EDGE / Math.max(width, height)
    this.segmentInput.width = Math.max(1, Math.round(width * scale))
    this.segmentInput.height = Math.max(1, Math.round(height * scale))
    this.segmentCtx.drawImage(this.video, 0, 0, this.segmentInput.width, this.segmentInput.height)

    return this.segmenter?.confidence(this.segmentInput, performance.now()) ?? null
  }

  private paintBackground(width: number, height: number): void {
    this.backgroundCtx.imageSmoothingEnabled = true
    this.backgroundCtx.imageSmoothingQuality = 'high'
    this.backgroundCtx.filter = this.canFilter ? `blur(${this.plan.radius}px)` : 'none'
    this.backgroundCtx.drawImage(this.video, this.plan.pad, this.plan.pad, this.plan.width, this.plan.height)
    this.backgroundCtx.filter = 'none'

    this.outputCtx.imageSmoothingEnabled = true
    this.outputCtx.imageSmoothingQuality = 'high'
    this.outputCtx.drawImage(
      this.background,
      this.plan.pad,
      this.plan.pad,
      this.plan.width,
      this.plan.height,
      0,
      0,
      width,
      height,
    )
  }

  private paintSubject(width: number, height: number): void {
    this.subjectCtx.globalCompositeOperation = 'source-over'
    this.subjectCtx.drawImage(this.video, 0, 0, width, height)

    const mask = this.mask
    if (!mask) return

    const image = this.maskImageFor(mask)
    writeMaskAlpha(mask.values, image.data)
    this.maskCtx.putImageData(image, 0, 0)

    this.subjectCtx.globalCompositeOperation = 'destination-in'
    this.subjectCtx.imageSmoothingEnabled = true
    this.subjectCtx.imageSmoothingQuality = 'high'
    // The fade is drawn with the mask, so the person's edge meets the room
    // over a few pixels instead of on a line the eye can follow.
    this.subjectCtx.filter = this.canFilter ? `blur(${featherRadius(width)}px)` : 'none'
    this.subjectCtx.drawImage(this.maskCanvas, 0, 0, mask.width, mask.height, 0, 0, width, height)
    this.subjectCtx.filter = 'none'
    this.subjectCtx.globalCompositeOperation = 'source-over'
  }

  // maskImageFor keeps one ImageData per mask shape: the model's answer is
  // the same size every frame, so this is allocated once per camera.
  private maskImageFor(mask: Mask): ImageData {
    const known = this.maskImage
    if (known && known.width === mask.width && known.height === mask.height) return known

    const image = new ImageData(mask.width, mask.height)
    this.maskImage = image
    this.maskCanvas.width = mask.width
    this.maskCanvas.height = mask.height

    return image
  }

  private resize(width: number, height: number): void {
    if (this.output.width === width && this.output.height === height) return

    this.output.width = width
    this.output.height = height
    this.subject.width = width
    this.subject.height = height

    this.plan = blurPlan(width, height, this.canFilter ? BLUR_DOWNSCALE : FILTERLESS_DOWNSCALE)
    this.background.width = this.plan.width + 2 * this.plan.pad
    this.background.height = this.plan.height + 2 * this.plan.pad
  }
}

let loader: typeof import('@/lib/vision').loadSegmenter | null = null

// loadSegmenterFor keeps the vision module out of the initial bundle: the
// runtime is megabytes of WebAssembly that most calls never need.
async function loadSegmenterFor(shape: SegmentShape): Promise<Segmenter> {
  loader ??= (await import('@/lib/vision')).loadSegmenter

  return loader(shape)
}

export function startBlur(source: MediaStreamTrack, options: BlurOptions = {}): BlurPipeline {
  return new CanvasBlur(source, options)
}

/** Whether this browser can publish a canvas track at all. */
export function blurSupported(): boolean {
  return typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function'
}
