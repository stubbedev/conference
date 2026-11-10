import { CanvasCompositor } from '@/lib/blur-2d'
import { GlCompositor, gpuCompositing, type BlurCanvas, type Compositor } from '@/lib/blur-gl'
import { ElementSource, FrameSource, frameApis, type FrameApis, type FrameWriter, type VideoSource } from '@/lib/frames'
import { modelFor, segmentCadence, stabiliseMask, type SegmentShape } from '@/lib/mask'
import type { Mask, Segmenter } from '@/lib/vision'

const FPS = 30
const SEGMENT_LONG_EDGE = 256
const SEGMENT_SMOOTHING = 0.3

export interface BlurOptions {
  onUnavailable?: (err: unknown) => void
}

export interface BlurPipeline {
  readonly track: MediaStreamTrack
  rewire(source: MediaStreamTrack): void
  stop(): void
}

interface Output {
  readonly track: MediaStreamTrack
  emit(canvas: BlurCanvas, timestamp: number): void
  stop(): void
}

function generatorOutput(apis: FrameApis): Output {
  const generator = new apis.MediaStreamTrackGenerator({ kind: 'video' })
  const writer: FrameWriter = generator.writable.getWriter()
  let writing = false
  return {
    track: generator,
    emit(canvas, timestamp) {
      if (writing) return
      const frame = new VideoFrame(canvas, { timestamp })
      writing = true
      writer
        .write(frame)
        .catch((err: unknown) => {
          frame.close()
          console.warn('blur: writing a composited frame', err)
        })
        .finally(() => {
          writing = false
        })
    },
    stop() {
      void writer.close().catch(() => {})
      generator.stop()
    },
  }
}

function captureOutput(canvas: HTMLCanvasElement): Output {
  const stream = canvas.captureStream(FPS)
  const [track] = stream.getVideoTracks()
  if (!track) throw new Error('this browser cannot publish a composited camera')
  return {
    track,
    emit() {},
    stop() {
      for (const each of stream.getTracks()) each.stop()
    },
  }
}

class GlBlur implements BlurPipeline {
  readonly track: MediaStreamTrack

  private readonly apis = frameApis()
  private readonly canvas: BlurCanvas
  private readonly compositor: Compositor
  private readonly output: Output
  private readonly segmentInput = document.createElement('canvas')
  private readonly segmentCtx: CanvasRenderingContext2D
  private readonly options: BlurOptions
  private source: VideoSource
  private segmenter: Segmenter | null = null
  private segmentShape: SegmentShape | null = null
  private segmentRequested: SegmentShape | null = null
  private segmentMs = 0
  private frames = 0
  private maskBuffers: [Float32Array, Float32Array] | null = null
  private maskBuffer = 0
  private stopped = false
  private failed = false

  constructor(source: MediaStreamTrack, options: BlurOptions) {
    this.options = options
    const segmentCtx = this.segmentInput.getContext('2d', { alpha: false, willReadFrequently: false })
    if (!segmentCtx) throw new Error('this browser cannot prepare frames for the blur model')
    this.segmentCtx = segmentCtx

    const compose = gpuCompositing() ? GlCompositor : CanvasCompositor
    if (this.apis) {
      this.canvas = new OffscreenCanvas(1, 1)
      this.compositor = new compose(this.canvas)
      this.output = generatorOutput(this.apis)
    } else {
      const element = document.createElement('canvas')
      this.canvas = element
      this.compositor = new compose(element)
      this.output = captureOutput(element)
    }
    this.track = this.output.track
    this.source = this.open(source)
  }

  rewire(source: MediaStreamTrack): void {
    this.source.close()
    this.forgetMask()
    this.source = this.open(source)
  }

  stop(): void {
    this.stopped = true
    this.source.close()
    this.output.stop()
  }

  private open(track: MediaStreamTrack): VideoSource {
    return this.apis ? new FrameSource(this.apis, track, this.paint) : new ElementSource(track, this.paint)
  }

  private forgetMask(): void {
    this.maskBuffers = null
    this.compositor.clearMask()
  }

  private readonly paint = (): void => {
    if (this.stopped || this.failed) return
    const image = this.source.image
    const width = this.source.width
    const height = this.source.height
    if (!image || width === 0 || height === 0) return

    try {
      this.composite(image as TexImageSource & CanvasImageSource, width, height)
    } catch (err) {
      this.fail(err)
    }
  }

  private composite(image: TexImageSource & CanvasImageSource, width: number, height: number): void {
    if (this.compositor.lost) throw new Error('the GPU dropped the background blur')

    const shape = modelFor(width, height)
    if (this.segmentShape !== shape) this.useModel(shape)
    if (this.segmenter && this.segmentShape === shape) this.segmentIfDue(image, width, height)
    this.frames += 1

    this.compositor.render(image, width, height)
    const timestamp = image instanceof VideoFrame ? image.timestamp : Math.round(performance.now() * 1000)
    this.output.emit(this.canvas, timestamp)
  }

  private fail(err: unknown): void {
    this.failed = true
    console.warn('blur: compositing a camera frame', err)
    this.options.onUnavailable?.(err)
  }

  private useModel(shape: SegmentShape): void {
    this.forgetMask()
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

  private segmentIfDue(image: CanvasImageSource, width: number, height: number): void {
    const cadence = segmentCadence(this.segmentMs, 1000 / FPS)
    if (this.frames % cadence !== 0) return

    const started = performance.now()
    const fresh = this.segment(image, width, height)
    const took = performance.now() - started

    if (fresh) this.compositor.uploadMask(this.stabilise(fresh))

    this.segmentMs = this.segmentMs === 0 ? took : this.segmentMs * (1 - SEGMENT_SMOOTHING) + took * SEGMENT_SMOOTHING
  }

  private stabilise(mask: Mask): Mask {
    const length = mask.values.length
    if (!this.maskBuffers || this.maskBuffers[0].length !== length) {
      this.maskBuffers = [new Float32Array(length), new Float32Array(length)]
      stabiliseMask(this.maskBuffers[0], null, mask.values)
      this.maskBuffer = 0
      return { values: this.maskBuffers[0], width: mask.width, height: mask.height }
    }

    const previous = this.maskBuffers[this.maskBuffer]
    const next = this.maskBuffers[1 - this.maskBuffer]
    stabiliseMask(next, previous, mask.values)
    this.maskBuffer = 1 - this.maskBuffer
    return { values: next, width: mask.width, height: mask.height }
  }

  private segment(image: CanvasImageSource, width: number, height: number): Mask | null {
    const scale = SEGMENT_LONG_EDGE / Math.max(width, height)
    const inputWidth = Math.max(1, Math.round(width * scale))
    const inputHeight = Math.max(1, Math.round(height * scale))
    if (this.segmentInput.width !== inputWidth || this.segmentInput.height !== inputHeight) {
      this.segmentInput.width = inputWidth
      this.segmentInput.height = inputHeight
    }
    this.segmentCtx.drawImage(image, 0, 0, inputWidth, inputHeight)
    return this.segmenter?.confidence(this.segmentInput, performance.now()) ?? null
  }
}

let loader: typeof import('@/lib/vision').loadSegmenter | null = null

async function loadSegmenterFor(shape: SegmentShape): Promise<Segmenter> {
  loader ??= (await import('@/lib/vision')).loadSegmenter
  return loader(shape)
}

export function startBlur(source: MediaStreamTrack, options: BlurOptions = {}): BlurPipeline {
  return new GlBlur(source, options)
}

export function blurSupported(): boolean {
  return frameApis() !== null || (typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function')
}
