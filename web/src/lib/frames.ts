import { errorName } from './errors.ts'

interface FrameRead {
  value?: VideoFrame
  done: boolean
}

interface FrameReader {
  read(): Promise<FrameRead>
  cancel(): Promise<void>
}

const ENDED: FrameRead = { done: true }

interface TrackProcessor {
  readable: { getReader(): FrameReader }
}

export interface FrameWriter {
  write(frame: VideoFrame): Promise<void>
  close(): Promise<void>
}

export interface TrackGenerator extends MediaStreamTrack {
  writable: { getWriter(): FrameWriter }
}

export interface FrameApis {
  MediaStreamTrackProcessor: new (init: { track: MediaStreamTrack }) => TrackProcessor
  MediaStreamTrackGenerator: new (init: { kind: 'video' }) => TrackGenerator
}

export function frameApis(): FrameApis | null {
  const scope = globalThis as unknown as Partial<FrameApis>
  if (!scope.MediaStreamTrackProcessor || !scope.MediaStreamTrackGenerator || typeof OffscreenCanvas === 'undefined') return null
  return scope as FrameApis
}

// Ends a generated track once the frame still being written has gone
// out: stopping the track first fails that write, and the close with it.
export function endGenerator(generator: TrackGenerator, writer: FrameWriter): void {
  void writer
    .close()
    .catch((err: unknown) => console.warn('frames: closing a generated track', err))
    .finally(() => generator.stop())
}

export interface VideoSource {
  readonly image: CanvasImageSource | null
  readonly width: number
  readonly height: number
  close(): void
}

export class ElementSource implements VideoSource {
  private readonly video = document.createElement('video')
  private request = 0

  constructor(track: MediaStreamTrack, onFrame?: () => void) {
    this.video.muted = true
    this.video.playsInline = true
    this.video.srcObject = new MediaStream([track])
    // close() interrupts a play() that has not started, which is an AbortError.
    void this.video.play().catch((err: unknown) => {
      if (errorName(err) !== 'AbortError') console.warn('frames: playing a track to read its picture', err)
    })
    if (onFrame) this.follow(onFrame)
  }

  private follow(onFrame: () => void): void {
    this.request = this.video.requestVideoFrameCallback(() => {
      onFrame()
      if (this.video.srcObject) this.follow(onFrame)
    })
  }

  get image(): CanvasImageSource | null {
    return this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? this.video : null
  }

  get width(): number {
    return this.video.videoWidth
  }

  get height(): number {
    return this.video.videoHeight
  }

  close(): void {
    if (this.request) this.video.cancelVideoFrameCallback(this.request)
    this.video.pause()
    this.video.srcObject = null
  }
}

export class FrameSource implements VideoSource {
  private frame: VideoFrame | null = null
  private readonly reader: FrameReader
  private closed = false

  constructor(apis: FrameApis, track: MediaStreamTrack, onFrame: () => void) {
    this.reader = new apis.MediaStreamTrackProcessor({ track }).readable.getReader()
    void this.pump(onFrame)
  }

  get image(): CanvasImageSource | null {
    return this.frame
  }

  get width(): number {
    return this.frame?.displayWidth ?? 0
  }

  get height(): number {
    return this.frame?.displayHeight ?? 0
  }

  close(): void {
    this.closed = true
    void this.reader.cancel().catch((err: unknown) => console.warn('frames: releasing the reader of a track', err))
    this.frame?.close()
    this.frame = null
  }

  private async pump(onFrame: () => void): Promise<void> {
    for (;;) {
      const { value, done } = await this.reader.read().catch((err: unknown) => {
        console.warn('frames: reading the frames of a track, whose picture stops here', err)
        return ENDED
      })
      if (done || !value) return
      if (this.closed) {
        value.close()
        return
      }
      this.frame?.close()
      this.frame = value
      onFrame()
    }
  }
}
