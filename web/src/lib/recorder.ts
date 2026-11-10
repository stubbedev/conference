// CallRecorder composites the visible call — every tile plus one mixed
// audio track — onto a canvas and captures it with MediaRecorder,
// entirely inside the recording browser. The file never touches the
// server, which keeps local recording compatible with the E2EE promise:
// the SFU relays ciphertext it cannot decode, let alone record.

import { audioContext, playMediaElement } from '@/hooks/media'
import { errorMessage } from './errors.ts'
import { ElementSource, endGenerator, FrameSource, frameApis, type FrameWriter, type TrackGenerator, type VideoSource } from './frames.ts'
import { initials } from './names.ts'
import { focusKey, gridRects, nextSpeakerFocus, speakingKeys, spotlightRects, type Rect, type SpeakerFocus } from './recording-layout.ts'
import { SPEAKING_SAMPLE_MS } from './speaking.ts'
import { VoiceMeter } from './voice-meter.ts'
import { withDuration } from './webm.ts'

export interface RecorderTile {
  key: string
  stream: MediaStream | null
  name: string
  local: boolean
  /** Spotlights the tile, mirroring the recorder's pinned view. */
  pinned: boolean
  screen: boolean
  /**
   * The sound the tile is recorded with and its speaker spotlighted by:
   * what the recording member hears, so a speaker's translated voice
   * where it replaces their own.
   */
  heard: MediaStream | null
}

const CANVAS_WIDTH = 1280
const CANVAS_HEIGHT = 720
const CANVAS_FPS = 30
const CHUNK_MS = 4000
const LABEL_FONT = '500 16px system-ui, sans-serif'
// The Info element that carries the duration sits at the very start of
// the file, well inside this window; the rest is copied, never parsed.
const DURATION_HEAD_BYTES = 256 * 1024
const COPY_CHUNK_BYTES = 8 * 1024 * 1024

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
    (frameApis() !== null || typeof HTMLCanvasElement.prototype.captureStream === 'function')
  )
}

export function recorderKeepsPaceHidden(): boolean {
  return frameApis() !== null
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
  source: VideoSource
  track: MediaStreamTrack
}

type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

// One track mixed into the recording and measured for the speaker
// spotlight. In WebKit browsers remote tracks, a translated voice among
// them, route through a detached <audio> element and a
// MediaElementAudioSourceNode, because WebKit's MediaStreamAudioSourceNode
// produces silence for WebRTC streams. Once an element is captured by the
// graph its audio only flows through it, so the mix never leaks to the
// speakers; the user gesture that started the recording unlocks play().
// Chrome is the other way round: the element path gives silence for a
// MediaStream there, so Chrome and Firefox read every track directly.
// Every iOS browser is WebKit too; Chrome and Edge say "Chrome/" besides "AppleWebKit".
const WEBKIT = /AppleWebKit/.test(navigator.userAgent) && !/Chrome\/|Chromium\//.test(navigator.userAgent)

interface MixedVoice {
  source: AudioNode
  meter: VoiceMeter
  element?: HTMLAudioElement
}

const TILE_GAP = 8
const TILE_RADIUS = 10
const PLACEHOLDER_FILL = '#26262b'
const INITIALS_FONT = '600 40px system-ui, sans-serif'

// Chunked data streams into the origin-private file system where the
// browser has it (Chrome, Firefox, Safari 16.4+), keeping memory flat
// for calls of any length and making the final download disk-backed.
// Browsers without it buffer chunks in memory for the whole call, up to
// a cap: past that the recording ends with what it has instead of the
// tab dying with everything still inside it.
interface DiskSink {
  handle: FileSystemFileHandle
  writable: FileSystemWritableFileStream
  writing: Promise<void>
}

interface MemorySink {
  chunks: Blob[]
  bytes: number
}

const MEMORY_SINK_LIMIT_BYTES = 1024 * 1024 * 1024

export class CallRecorder {
  private slug: string
  private ended: ((reason: string) => void) | null
  private readonly apis = frameApis()
  private canvas: HTMLCanvasElement | OffscreenCanvas
  private ctx: Canvas2D
  private generator: TrackGenerator | null = null
  private writer: FrameWriter | null = null
  private writing = false
  private entries = new Map<string, RecorderEntry>()
  private latest: RecorderTile[] = []
  private mixed = new Map<MediaStreamTrack, MixedVoice>()
  private mixer: MediaStreamAudioDestinationNode | null = null
  private storageRoot: FileSystemDirectoryHandle | null = null
  private canvasStream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private filename = ''
  private sink: DiskSink | MemorySink | null = null
  private sourcesWatched: AbortController | null = null
  private starting: Promise<void> | null = null
  private drawing = false
  private frame = 0
  private paintTimer = 0
  private lastPaint = 0
  private lastListen = 0
  private speaker: SpeakerFocus = null
  private endedReason = ''
  private startedAt = 0
  private finishing: Promise<void> | null = null
  private stopped: (() => void) | null = null

  constructor(slug: string, ended?: (reason: string) => void) {
    this.slug = slug
    this.ended = ended ?? null
    if (this.apis) {
      this.canvas = new OffscreenCanvas(CANVAS_WIDTH, CANVAS_HEIGHT)
    } else {
      this.canvas = document.createElement('canvas')
      this.canvas.width = CANVAS_WIDTH
      this.canvas.height = CANVAS_HEIGHT
    }
    const ctx = this.canvas.getContext('2d') as Canvas2D | null
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
        entry = { source: this.sourceFor(track), track }
        this.entries.set(tile.key, entry)
      } else {
        // A device switch replaces the tile's track under the same key;
        // re-bind so the composite follows the live capture.
        if (entry.track !== track) {
          entry.source.close()
          entry.track = track
          entry.source = this.sourceFor(track)
        }
      }
    }
    for (const [key, entry] of this.entries) {
      if (seen.has(key)) continue
      entry.source.close()
      this.entries.delete(key)
    }

    this.connectAudio(tiles)
  }

  private sourceFor(track: MediaStreamTrack): VideoSource {
    return this.apis ? new FrameSource(this.apis, track, this.frameArrived) : new ElementSource(track)
  }

  private frameArrived = (): void => {
    if (!this.active || performance.now() - this.lastPaint < 1000 / CANVAS_FPS - 1) return
    this.emitFrame()
  }

  private emitFrame(): void {
    const writer = this.writer
    if (!writer || !(this.canvas instanceof OffscreenCanvas) || this.writing) return
    this.lastPaint = performance.now()
    this.paint()
    const frame = new VideoFrame(this.canvas, { timestamp: Math.round(this.lastPaint * 1000) })
    this.writing = true
    writer
      .write(frame)
      .catch((err: unknown) => {
        frame.close()
        this.endUnexpectedly(`the recording's picture could not be written: ${errorMessage(err)}`)
      })
      .finally(() => {
        this.writing = false
      })
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

    let video: MediaStreamTrack
    if (this.apis) {
      this.generator = new this.apis.MediaStreamTrackGenerator({ kind: 'video' })
      this.writer = this.generator.writable.getWriter()
      video = this.generator
    } else {
      this.canvasStream = (this.canvas as HTMLCanvasElement).captureStream(CANVAS_FPS)
      video = this.canvasStream.getVideoTracks()[0]
    }
    const tracks: MediaStreamTrack[] = [video]
    if (this.mixer) tracks.push(...this.mixer.stream.getAudioTracks())

    this.recorder = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime } : undefined)
    this.recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) this.writeChunk(ev.data)
    }
    // A recorder error leaves state "inactive"; flush whatever landed so
    // the file is never lost, and say why the recording ended.
    this.recorder.onerror = (ev) => {
      const error = (ev as { error?: DOMException }).error
      this.endUnexpectedly(error?.message || error?.name || 'the recorder failed')
    }
    this.recorder.onstop = () => {
      const callback = this.stopped
      this.stopped = null
      if (callback) {
        callback()
        return
      }
      // Nobody asked for this stop: the recorder gave up on its own.
      void this.finish()
    }
    // A source that ends (the canvas capture or the audio mix stopped by
    // the browser) ends the recording; keep the file and report it. The
    // recorder ends its own sources when it is done, which is not that.
    this.sourcesWatched = new AbortController()
    for (const track of tracks) {
      track.addEventListener('ended', () => this.endUnexpectedly('a media source stopped'), { signal: this.sourcesWatched.signal })
    }

    // Name the file after the container MediaRecorder actually picked,
    // which only it knows for sure once constructed.
    this.filename = recordingFilename(this.slug, this.recorder.mimeType || mime)
    await this.openSink()

    this.recorder.start(CHUNK_MS)
    this.startedAt = performance.now()
    if (this.apis) {
      this.emitFrame()
      this.paintTimer = window.setInterval(() => {
        if (this.active && performance.now() - this.lastPaint >= 1000) this.emitFrame()
      }, 1000)
      return
    }
    this.pumpFrames()
    // rAF stops entirely in hidden tabs, which would freeze the picture
    // in a background recording for as long as the tab stays hidden;
    // audio timers keep running at a throttled rate, so repaint at 1fps
    // to keep the grid current while the call is backgrounded, and pick
    // the frame loop back up the moment the tab is visible again.
    this.paintTimer = window.setInterval(() => {
      if (!this.active) return
      this.paint()
      this.pumpFrames()
    }, 1000)
  }

  async stop(): Promise<void> {
    await this.starting?.catch(() => {})
    this.starting = null

    if (this.finishing) {
      await this.finishing
      return
    }

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

  private finish(): Promise<void> {
    this.finishing ??= (async () => {
      const ended = this.ended
      this.ended = null
      const reason = this.endedReason || 'the recorder stopped'
      await this.flushAndDispose()
      ended?.(reason)
    })()
    return this.finishing
  }

  // endUnexpectedly ends the recording on its own terms and lets the
  // page know, so a recorder that gives up after an hour is never a
  // silent loss: the file downloads and the badge clears.
  private endUnexpectedly(reason: string): void {
    this.endedReason ||= reason
    const recorder = this.recorder
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
      return
    }
    void this.finish()
  }

  private async openSink(): Promise<void> {
    try {
      // A recording is worth far too much to lose to a browser that
      // evicts origin storage under disk pressure mid-call.
      void navigator.storage?.persist?.().catch(() => {})
      const root = await navigator.storage.getDirectory()
      const handle = await root.getFileHandle(this.filename, { create: true })
      const writable = await handle.createWritable()
      this.storageRoot = root
      this.sink = { handle, writable, writing: Promise.resolve() }
    } catch {
      this.sink = { chunks: [], bytes: 0 }
    }
  }

  private writeChunk(chunk: Blob): void {
    const sink = this.sink
    if (!sink) return
    if ('writable' in sink) {
      // Writes are chained, never awaited inline: each chunk reaches the
      // disk in order without holding the encoder, and without piling the
      // whole call up in memory when the disk is slow.
      sink.writing = sink.writing
        .then(() => sink.writable.write(chunk))
        .then(() => undefined)
        .catch((err: unknown) => {
          // The bytes written so far are a playable file; hand that over
          // instead of restarting the buffer inside a doomed tab.
          console.warn('recorder: writing the recording to disk', err)
          this.endUnexpectedly('this browser could not keep writing the recording to disk')
        })
      return
    }
    sink.chunks.push(chunk)
    sink.bytes += chunk.size
    if (sink.bytes > MEMORY_SINK_LIMIT_BYTES) {
      this.endUnexpectedly('this browser cannot stream the file to disk and ran out of memory to buffer it')
    }
  }

  private async flushAndDispose(): Promise<void> {
    const sink = this.sink
    const mime = this.recorder?.mimeType
    this.sink = null
    try {
      if (sink && 'writable' in sink) {
        await sink.writing.catch(() => {})
        await sink.writable.close()
        const file = await sink.handle.getFile()
        if (file.size > 0) {
          const { blob, temporary } = await this.recordingWithDuration(file, mime)
          saveFile(blob, this.filename)
          // The download carries the bytes now; drop the origin-private
          // copies so a recording never lives twice. Delayed long enough
          // that the download's read has certainly finished.
          const root = this.storageRoot
          const names = temporary ? [this.filename, temporary] : [this.filename]
          window.setTimeout(() => {
            for (const name of names) void root?.removeEntry(name).catch(() => {})
          }, 10_000)
        }
      } else if (sink && sink.chunks.length > 0) {
        const file = new Blob(sink.chunks, { type: mime || 'video/webm' })
        const head = await this.headWithDuration(file, mime)
        saveFile(head ? new Blob([head.bytes, file.slice(head.consumed)]) : file, this.filename)
      }
    } finally {
      this.dispose()
    }
  }

  // headWithDuration rewrites the first bytes of the recording so they
  // carry its length, and reports how many bytes of the original file
  // those replace: inserting the Duration makes the head longer than what
  // was read, and the tail must start where the head began.
  private async headWithDuration(
    blob: Blob,
    mime?: string,
  ): Promise<{ bytes: Uint8Array<ArrayBuffer>; consumed: number } | null> {
    if (!(mime ?? blob.type).includes('webm')) return null
    if (typeof blob.slice !== 'function') {
      console.warn('recorder: this browser cannot read the recording back in slices, so it is saved without a duration')
      return null
    }
    try {
      const head = new Uint8Array(await blob.slice(0, DURATION_HEAD_BYTES).arrayBuffer())
      const bytes = withDuration(head, this.startedAt > 0 ? performance.now() - this.startedAt : 0)
      return { bytes, consumed: head.length }
    } catch (err) {
      console.warn('recorder: giving the recording a duration, keeping the file as recorded', err)
      return null
    }
  }

  // recordingWithDuration writes the patched head and then the untouched
  // tail into a second origin-private file, so an hour-long recording is
  // never held in memory and the download streams from disk.
  private async recordingWithDuration(
    file: File,
    mime?: string,
  ): Promise<{ blob: Blob; temporary: string | null }> {
    const head = await this.headWithDuration(file, mime)
    const root = this.storageRoot
    if (!head || !root) return { blob: file, temporary: null }
    const temporary = `${this.filename}.duration`
    try {
      const handle = await root.getFileHandle(temporary, { create: true })
      const writable = await handle.createWritable()
      try {
        await writable.write(head.bytes)
        for (let offset = head.consumed; offset < file.size; offset += COPY_CHUNK_BYTES) {
          await writable.write(file.slice(offset, Math.min(offset + COPY_CHUNK_BYTES, file.size)))
        }
      } finally {
        await writable.close()
      }
      return { blob: await handle.getFile(), temporary }
    } catch (err) {
      console.warn('recorder: writing the recording with its duration to disk, keeping the file as recorded', err)
      await root.removeEntry(temporary).catch(() => {})
      return { blob: file, temporary: null }
    }
  }

  private connectAudio(tiles: RecorderTile[]): void {
    const ctx = audioContext()
    const mixer = this.mixer
    if (!ctx || !mixer) return

    const heard = new Map<MediaStreamTrack, boolean>()
    for (const tile of tiles) {
      for (const track of tile.heard?.getAudioTracks() ?? []) {
        if (track.readyState !== 'ended') heard.set(track, tile.local)
      }
    }

    for (const [track, voice] of this.mixed) {
      if (heard.has(track)) continue
      this.disconnectVoice(voice)
      this.mixed.delete(track)
    }

    for (const [track, local] of heard) {
      if (!this.mixed.has(track)) this.mixed.set(track, this.mixVoice(ctx, mixer, track, local))
    }
  }

  private mixVoice(ctx: AudioContext, mixer: MediaStreamAudioDestinationNode, track: MediaStreamTrack, local: boolean): MixedVoice {
    let source: AudioNode
    let element: HTMLAudioElement | undefined
    if (local || !WEBKIT) {
      source = ctx.createMediaStreamSource(new MediaStream([track]))
    } else {
      element = document.createElement('audio')
      element.srcObject = new MediaStream([track])
      playMediaElement(element)
      source = ctx.createMediaElementSource(element)
    }
    const meter = new VoiceMeter(ctx)
    source.connect(mixer)
    source.connect(meter.input)
    return { source, meter, element }
  }

  private disconnectVoice(voice: MixedVoice): void {
    voice.source.disconnect()
    voice.meter.input.disconnect()
    if (voice.element) {
      voice.element.pause()
      voice.element.srcObject = null
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
    this.drawing = this.active
    if (this.drawing) this.frame = requestAnimationFrame(this.draw)
  }

  // pumpFrames (re)starts the frame loop. A hidden tab stops rAF while
  // the call keeps running, and the loop must come back on its own when
  // the tab does; the paint timer calls this every second so a broken
  // chain can never outlive the recording.
  private pumpFrames(): void {
    if (this.drawing || !this.active) return
    this.drawing = true
    this.frame = requestAnimationFrame(this.draw)
  }

  private paint(): void {
    const { ctx, canvas } = this
    ctx.fillStyle = '#000000'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    const tiles = this.latest
    if (tiles.length === 0) return

    this.listen()
    const area = { x: TILE_GAP, y: TILE_GAP, width: canvas.width - 2 * TILE_GAP, height: canvas.height - 2 * TILE_GAP }
    const focus = focusKey(tiles, this.speaker?.key ?? null)
    const featured = focus === null ? undefined : tiles.find((tile) => tile.key === focus)
    if (!featured) {
      gridRects(tiles.length, area, TILE_GAP).forEach((rect, index) => {
        const tile = tiles[index]
        if (tile) this.drawTile(tile, rect)
      })
      return
    }

    const others = tiles.filter((tile) => tile !== featured)
    const { main, strip } = spotlightRects(others.length, area, TILE_GAP)
    this.drawTile(featured, main)
    others.forEach((tile, index) => {
      const rect = strip[index]
      if (rect) this.drawTile(tile, rect)
    })
  }

  private listen(): void {
    const now = performance.now()
    if (now - this.lastListen < SPEAKING_SAMPLE_MS) return
    this.lastListen = now
    for (const voice of this.mixed.values()) voice.meter.sample(now)
    const speaking = speakingKeys(this.latest, (heard) =>
      heard.getAudioTracks().some((track) => this.mixed.get(track)?.meter.speaking(now) === true),
    )
    this.speaker = nextSpeakerFocus(this.speaker, speaking, now)
  }

  private drawTile(tile: RecorderTile, rect: Rect): void {
    const ctx = this.ctx
    const source = this.entries.get(tile.key)?.source
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(rect.x, rect.y, rect.width, rect.height, TILE_RADIUS)
    ctx.clip()
    ctx.fillStyle = PLACEHOLDER_FILL
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height)
    if (source?.image) {
      this.drawFitted(source, rect, tile.screen ? 'contain' : 'cover')
    } else {
      ctx.fillStyle = '#ffffff'
      ctx.font = INITIALS_FONT
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(initials(tile.name), rect.x + rect.width / 2, rect.y + rect.height / 2)
      ctx.textAlign = 'start'
      ctx.textBaseline = 'alphabetic'
    }
    ctx.restore()
    this.drawLabel(tile.name, rect.x, rect.y, rect.width, rect.height)
  }

  private drawFitted(source: VideoSource, rect: Rect, fit: 'cover' | 'contain'): void {
    const image = source.image
    const videoWidth = source.width
    const videoHeight = source.height
    if (!image || !videoWidth || !videoHeight) return

    const pick = fit === 'cover' ? Math.max : Math.min
    const scale = pick(rect.width / videoWidth, rect.height / videoHeight)
    const drawWidth = videoWidth * scale
    const drawHeight = videoHeight * scale
    this.ctx.drawImage(image, rect.x + (rect.width - drawWidth) / 2, rect.y + (rect.height - drawHeight) / 2, drawWidth, drawHeight)
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
    this.sourcesWatched?.abort()
    this.sourcesWatched = null
    cancelAnimationFrame(this.frame)
    this.drawing = false
    window.clearInterval(this.paintTimer)
    this.sink = null
    this.starting = null
    this.storageRoot = null
    for (const voice of this.mixed.values()) this.disconnectVoice(voice)
    this.mixed.clear()
    this.mixer = null
    for (const entry of this.entries.values()) entry.source.close()
    this.entries.clear()
    if (this.generator && this.writer) endGenerator(this.generator, this.writer)
    this.writer = null
    this.generator = null
    this.latest = []
    for (const track of this.canvasStream?.getTracks() ?? []) track.stop()
    this.canvasStream = null
    this.recorder = null
    this.startedAt = 0
    this.stopped = null
  }
}

function recordingFilename(slug: string, mime?: string): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `conference-${slug}-${stamp}.${mime?.includes('mp4') ? 'mp4' : 'webm'}`
}
