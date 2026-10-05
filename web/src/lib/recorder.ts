// CallRecorder composites the visible call — every tile plus one mixed
// audio track — onto a canvas and captures it with MediaRecorder,
// entirely inside the recording browser. The file never touches the
// server, which keeps local recording compatible with the E2EE promise:
// the SFU relays ciphertext it cannot decode, let alone record.

import { audioContext, playMediaElement } from '@/hooks/media'

export interface RecorderTile {
  key: string
  stream: MediaStream | null
  name: string
  local: boolean
}

const CANVAS_WIDTH = 1280
const CANVAS_HEIGHT = 720
const CANVAS_FPS = 30
const CHUNK_MS = 4000
const LABEL_FONT = '500 16px system-ui, sans-serif'

// Safari's MediaRecorder cannot produce WebM and rejects it outright;
// Chrome and Firefox prefer it. Whatever container actually comes out
// decides the file extension.
const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4',
]

export function recorderSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement.prototype.captureStream === 'function'
  )
}

export function saveFile(file: Blob, filename: string): void {
  const url = URL.createObjectURL(file)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

interface RecorderEntry {
  name: string
  video: HTMLVideoElement
  track: MediaStreamTrack
}

// One track mixed into the recording. Remote tracks route through a
// detached <audio> element and a MediaElementAudioSourceNode: Safari's
// MediaStreamAudioSourceNode produces silence for WebRTC streams, while
// the element path works everywhere. Once an element is captured by the
// graph its audio only flows through it, so the mix never leaks to the
// speakers; the user gesture that started the recording unlocks play().
interface MixedSource {
  track: MediaStreamTrack
  source: AudioNode
  element?: HTMLAudioElement
}

// Chunked data streams into the origin-private file system where the
// browser has it (Chrome, Firefox, Safari 16.4+), keeping memory flat
// for calls of any length and making the final download disk-backed.
// Browsers without it buffer chunks in memory for the whole call.
interface DiskSink {
  handle: FileSystemFileHandle
  writable: FileSystemWritableFileStream
}

interface MemorySink {
  chunks: Blob[]
}

export class CallRecorder {
  private slug: string
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private entries = new Map<string, RecorderEntry>()
  private latest: RecorderTile[] = []
  private mixed = new Map<MediaStreamTrack, MixedSource>()
  private mixer: MediaStreamAudioDestinationNode | null = null
  private storageRoot: FileSystemDirectoryHandle | null = null
  private canvasStream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private filename = ''
  private sink: DiskSink | MemorySink | null = null
  private starting: Promise<void> | null = null
  private frame = 0
  private paintTimer = 0
  private lastPaint = 0
  private stopped: (() => void) | null = null

  constructor(slug: string) {
    this.slug = slug
    this.canvas = document.createElement('canvas')
    this.canvas.width = CANVAS_WIDTH
    this.canvas.height = CANVAS_HEIGHT
    const ctx = this.canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D is unavailable in this browser.')
    this.ctx = ctx
  }

  get active(): boolean {
    return this.recorder !== null && this.recorder.state !== 'inactive'
  }

  setTiles(tiles: RecorderTile[]): void {
    this.latest = tiles

    const seen = new Set<string>()
    for (const tile of tiles) {
      const track = tile.stream?.getVideoTracks()[0]
      if (!track) continue
      seen.add(tile.key)

      let entry = this.entries.get(tile.key)
      if (!entry) {
        const video = document.createElement('video')
        video.muted = true
        video.playsInline = true
        video.srcObject = new MediaStream([track])
        void video.play().catch(() => {})
        entry = { name: tile.name, video, track }
        this.entries.set(tile.key, entry)
      } else {
        if (entry.name !== tile.name) entry.name = tile.name
        // A device switch replaces the tile's track under the same key;
        // re-bind so the composite follows the live capture.
        if (entry.track !== track) {
          entry.track = track
          entry.video.srcObject = new MediaStream([track])
        }
      }
    }
    for (const [key, entry] of this.entries) {
      if (seen.has(key)) continue
      entry.video.pause()
      entry.video.srcObject = null
      this.entries.delete(key)
    }

    this.connectAudio(tiles)
  }

  start(): Promise<void> {
    // Serialized so a stop() that arrives while the sink and recorder
    // are still being set up waits for the start to settle instead of
    // flushing a sink the start would then recreate.
    if (!this.starting) this.starting = this.doStart()
    return this.starting
  }

  private async doStart(): Promise<void> {
    if (this.active) return

    const ctx = audioContext()
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {})
    this.mixer = ctx ? ctx.createMediaStreamDestination() : null
    this.connectAudio(this.latest)

    const mime = MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate))

    this.canvasStream = this.canvas.captureStream(CANVAS_FPS)
    const tracks: MediaStreamTrack[] = [...this.canvasStream.getVideoTracks()]
    if (this.mixer) tracks.push(...this.mixer.stream.getAudioTracks())

    this.recorder = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime } : undefined)
    this.recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) this.writeChunk(ev.data)
    }
    // A recorder error leaves state "inactive"; flush whatever landed so
    // a stop() always resolves and the caller can still save the file.
    this.recorder.onerror = () => {
      if (this.recorder?.state !== 'inactive') this.recorder?.stop()
    }
    this.recorder.onstop = () => {
      const callback = this.stopped
      this.stopped = null
      callback?.()
    }

    // Name the file after the container MediaRecorder actually picked,
    // which only it knows for sure once constructed.
    this.filename = recordingFilename(this.slug, this.recorder.mimeType || mime)
    await this.openSink()

    this.recorder.start(CHUNK_MS)
    this.frame = requestAnimationFrame(this.draw)
    // rAF stops entirely in hidden tabs, which would freeze the picture
    // in a background recording for as long as the tab stays hidden;
    // audio timers keep running at a throttled rate, so repaint at 1fps
    // to keep the grid current while the call is backgrounded.
    this.paintTimer = window.setInterval(() => {
      if (this.active) this.paint()
    }, 1000)
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => {})
    this.starting = null

    const recorder = this.recorder
    if (!recorder || recorder.state === 'inactive') {
      await this.flushAndDispose()
      return
    }

    await new Promise<void>((resolve) => {
      this.stopped = resolve
      recorder.stop()
    })
    await this.flushAndDispose()
  }

  private async openSink(): Promise<void> {
    try {
      const root = await navigator.storage.getDirectory()
      const handle = await root.getFileHandle(this.filename, { create: true })
      const writable = await handle.createWritable()
      this.storageRoot = root
      this.sink = { handle, writable }
    } catch {
      this.sink = { chunks: [] }
    }
  }

  private writeChunk(chunk: Blob): void {
    const sink = this.sink
    if (!sink) return
    if ('writable' in sink) {
      sink.writable.write(chunk).catch(() => {
        // Quota or stream failure: keep the recording alive by falling
        // back to memory for the rest of the call.
        this.sink = { chunks: [] }
      })
      return
    }
    sink.chunks.push(chunk)
  }

  private async flushAndDispose(): Promise<void> {
    const sink = this.sink
    const mime = this.recorder?.mimeType
    this.sink = null
    try {
      if (sink && 'writable' in sink) {
        await sink.writable.close()
        const file = await sink.handle.getFile()
        if (file.size > 0) saveFile(file, this.filename)
        // The download carries the bytes now; drop the origin-private
        // copy so a recording never lives twice. Delayed long enough
        // that the download's read has certainly finished.
        const root = this.storageRoot
        const name = this.filename
        window.setTimeout(() => {
          void root?.removeEntry(name).catch(() => {})
        }, 10_000)
      } else if (sink && sink.chunks.length > 0) {
        saveFile(new Blob(sink.chunks, { type: mime || 'video/webm' }), this.filename)
      }
    } finally {
      this.dispose()
    }
  }

  private connectAudio(tiles: RecorderTile[]): void {
    const ctx = audioContext()
    const mixer = this.mixer
    if (!ctx || !mixer) return

    for (const [track, mixed] of this.mixed) {
      if (track.readyState !== 'ended') continue
      this.disconnectMixed(mixed)
      this.mixed.delete(track)
    }

    for (const tile of tiles) {
      for (const track of tile.stream?.getAudioTracks() ?? []) {
        if (this.mixed.has(track)) continue

        let source: AudioNode
        let element: HTMLAudioElement | undefined
        if (tile.local) {
          source = ctx.createMediaStreamSource(new MediaStream([track]))
        } else {
          element = document.createElement('audio')
          element.srcObject = new MediaStream([track])
          playMediaElement(element)
          source = ctx.createMediaElementSource(element)
        }
        source.connect(mixer)
        this.mixed.set(track, { track, source, element })
      }
    }
  }

  private disconnectMixed(mixed: MixedSource): void {
    try {
      mixed.source.disconnect()
    } catch {
      // already detached
    }
    if (mixed.element) {
      mixed.element.pause()
      mixed.element.srcObject = null
    }
  }

  private draw = () => {
    // Paint at the capture rate, not the display's: rAF ticks at the
    // monitor refresh (often twice the canvas's 30fps sampling), and a
    // redraw between samples is pure waste.
    const now = performance.now()
    if (now - this.lastPaint >= 1000 / CANVAS_FPS - 1) {
      this.lastPaint = now
      this.paint()
    }
    if (this.active) this.frame = requestAnimationFrame(this.draw)
  }

  private paint(): void {
    const { ctx, canvas } = this
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // A video without decoded frames yet would draw nothing and leave a
    // black cell; skipping it keeps the grid packed instead.
    const entries = [...this.entries.values()].filter(
      (entry) => entry.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA,
    )
    if (entries.length === 0) return

    const cols = Math.ceil(Math.sqrt(entries.length))
    const rows = Math.ceil(entries.length / cols)
    const cellWidth = canvas.width / cols
    const cellHeight = canvas.height / rows

    entries.forEach((entry, index) => {
      const x = (index % cols) * cellWidth
      const y = Math.floor(index / cols) * cellHeight
      this.drawCover(entry.video, x, y, cellWidth, cellHeight)
      this.drawLabel(entry.name, x, y, cellWidth, cellHeight)
    })
  }

  private drawCover(video: HTMLVideoElement, x: number, y: number, w: number, h: number): void {
    const videoWidth = video.videoWidth
    const videoHeight = video.videoHeight
    if (!videoWidth || !videoHeight) return

    const scale = Math.max(w / videoWidth, h / videoHeight)
    const drawWidth = videoWidth * scale
    const drawHeight = videoHeight * scale
    this.ctx.drawImage(video, x + (w - drawWidth) / 2, y + (h - drawHeight) / 2, drawWidth, drawHeight)
  }

  private drawLabel(name: string, x: number, y: number, w: number, h: number): void {
    if (!name) return

    const ctx = this.ctx
    ctx.font = LABEL_FONT
    const label = name.length > 40 ? `${name.slice(0, 39)}…` : name
    const textWidth = ctx.measureText(label).width
    const padX = 8
    const padY = 5
    const boxWidth = textWidth + padX * 2
    const boxHeight = 16 + padY * 2
    const boxX = x + 12
    const boxY = y + h - boxHeight - 12
    if (boxWidth >= w - 12) return

    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)'
    ctx.fillRect(boxX, boxY, boxWidth, boxHeight)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(label, boxX + padX, boxY + padY + 13)
  }

  private dispose(): void {
    cancelAnimationFrame(this.frame)
    window.clearInterval(this.paintTimer)
    this.starting = null
    this.storageRoot = null
    for (const mixed of this.mixed.values()) this.disconnectMixed(mixed)
    this.mixed.clear()
    this.mixer = null
    for (const entry of this.entries.values()) {
      entry.video.pause()
      entry.video.srcObject = null
    }
    this.entries.clear()
    this.latest = []
    for (const track of this.canvasStream?.getTracks() ?? []) track.stop()
    this.canvasStream = null
    this.recorder = null
    this.stopped = null
  }
}

function recordingFilename(slug: string, mime?: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `conference-${slug}-${stamp}.${mime?.includes('mp4') ? 'mp4' : 'webm'}`
}
