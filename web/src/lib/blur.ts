// Background blur: the camera's own frames, segmented by the model in
// vision.ts and composited here over a blurred copy of themselves. The
// result is a canvas track carrying the camera's picture, so everything
// downstream — simulcast layers, the room, a local recording — follows
// without knowing that blur exists.
//
// The composite runs at the capture's frame rate and the model is asked
// less often, on a downscaled copy: a mask barely changes between frames,
// a cut-out edge does not need more resolution than a face is wide, and
// segmentation is by far the most expensive thing in a call with the
// camera on.

import { segmentEvery, writeMaskAlpha } from '@/lib/mask'
import type { Mask, Segmenter } from '@/lib/vision'

/** How many frames a second the blurred camera publishes. */
const FPS = 30

/** How often per second the model is asked for a mask. */
const SEGMENT_FPS = 15

/** The model's input is this many pixels across, whatever the camera gives. */
const SEGMENT_LONG_EDGE = 256

/** The background is blurred by shrinking it this much and scaling it back up. */
const BLUR_DOWNSCALE = 8

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
  private readonly segmenter: Segmenter
  private readonly stream: MediaStream
  private readonly every: number
  private mask: Mask | null = null
  private maskImage: ImageData | null = null
  private frames = 0
  private frameRequest = 0
  private timer = 0
  private stopped = false

  constructor(source: MediaStreamTrack, segmenter: Segmenter) {
    this.segmenter = segmenter
    this.every = segmentEvery(FPS, SEGMENT_FPS)

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

    if (this.frames % this.every === 0) this.mask = this.segment(width, height)
    this.frames += 1

    if (!this.mask) {
      this.outputCtx.drawImage(this.video, 0, 0, width, height)

      return
    }

    this.backgroundCtx.drawImage(this.video, 0, 0, this.background.width, this.background.height)

    this.outputCtx.imageSmoothingEnabled = true
    this.outputCtx.imageSmoothingQuality = 'high'
    this.outputCtx.drawImage(this.background, 0, 0, this.background.width, this.background.height, 0, 0, width, height)

    this.paintSubject(width, height)
    this.outputCtx.drawImage(this.subject, 0, 0)
  }

  private segment(width: number, height: number): Mask | null {
    const scale = SEGMENT_LONG_EDGE / Math.max(width, height)
    this.segmentInput.width = Math.max(1, Math.round(width * scale))
    this.segmentInput.height = Math.max(1, Math.round(height * scale))
    this.segmentCtx.drawImage(this.video, 0, 0, this.segmentInput.width, this.segmentInput.height)

    return this.segmenter.confidence(this.segmentInput, performance.now())
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
    this.subjectCtx.drawImage(this.maskCanvas, 0, 0, mask.width, mask.height, 0, 0, width, height)
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
    this.background.width = Math.max(1, Math.round(width / BLUR_DOWNSCALE))
    this.background.height = Math.max(1, Math.round(height / BLUR_DOWNSCALE))
    this.subject.width = width
    this.subject.height = height
  }
}

export function startBlur(source: MediaStreamTrack, segmenter: Segmenter): BlurPipeline {
  return new CanvasBlur(source, segmenter)
}

/** Whether this browser can publish a canvas track at all. */
export function blurSupported(): boolean {
  return typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function'
}
