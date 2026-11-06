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
  /** Spotlights the tile, mirroring the recorder's pinned view. */
  pinned: boolean
  /** Left out of the mix: live translation replaces this speaker's voice. */
  audioMuted?: boolean
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
  pinned: boolean
}

// One track mixed into the recording. In WebKit browsers remote tracks
// route through a detached <audio> element and a
// MediaElementAudioSourceNode, because WebKit's MediaStreamAudioSourceNode
// produces silence for WebRTC streams. Once an element is captured by the
// graph its audio only flows through it, so the mix never leaks to the
// speakers; the user gesture that started the recording unlocks play().
// Chrome is the other way round: the element path gives silence for a
// MediaStream there, so Chrome and Firefox read every track directly.
// Every iOS browser is WebKit too; Chrome and Edge say "Chrome/" besides "AppleWebKit".
const WEBKIT = /AppleWebKit/.test(navigator.userAgent) && !/Chrome\/|Chromium\//.test(navigator.userAgent)

interface MixedSource {
  track: MediaStreamTrack
  source: AudioNode
  gain: GainNode
  element?: HTMLAudioElement
}

// A translated voice in the recorder's language, so the file plays as
// one conversation in that language. A remote (received) stream takes
// the <audio> element path in WebKit; a stream made in this browser is local.
interface TranslationAudio {
  stream: MediaStream
  local: boolean
}

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
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private entries = new Map<string, RecorderEntry>()
  private latest: RecorderTile[] = []
  private mixed = new Map<MediaStreamTrack, MixedSource>()
  private translations: TranslationAudio[] = []
  private translationsMixed: MixedSource[] = []
  private mixer: MediaStreamAudioDestinationNode | null = null
  private storageRoot: FileSystemDirectoryHandle | null = null
  private canvasStream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private filename = ''
  private sink: DiskSink | MemorySink | null = null
  private starting: Promise<void> | null = null
  private drawing = false
  private frame = 0
  private paintTimer = 0
  private lastPaint = 0
  private endedReason = ''
  private finishing: Promise<void> | null = null
  private stopped: (() => void) | null = null

  constructor(slug: string, ended?: (reason: string) => void) {
    this.slug = slug
    this.ended = ended ?? null
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
        entry = { name: tile.name, video, track, pinned: tile.pinned }
        this.entries.set(tile.key, entry)
      } else {
        if (entry.name !== tile.name) entry.name = tile.name
        if (entry.pinned !== tile.pinned) entry.pinned = tile.pinned
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

  /** Mixes these translated voices (one per other-language speaker) into the recording. */
  setTranslations(translations: TranslationAudio[]): void {
    const same =
      translations.length === this.translations.length &&
      translations.every((t, i) => t.stream === this.translations[i].stream && t.local === this.translations[i].local)
    if (same) return
    this.translations = translations
    this.connectTranslations()
  }

  private async doStart(): Promise<void> {
    if (this.active) return

    const ctx = audioContext()
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {})
    this.mixer = ctx ? ctx.createMediaStreamDestination() : null
    this.connectAudio(this.latest)
    this.connectTranslations()

    const mime = MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate))

    this.canvasStream = this.canvas.captureStream(CANVAS_FPS)
    const tracks: MediaStreamTrack[] = [...this.canvasStream.getVideoTracks()]
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
    // the browser) ends the recording; keep the file and report it.
    for (const track of tracks) {
      track.addEventListener('ended', () => this.endUnexpectedly('a media source stopped'))
    }

    // Name the file after the container MediaRecorder actually picked,
    // which only it knows for sure once constructed.
    this.filename = recordingFilename(this.slug, this.recorder.mimeType || mime)
    await this.openSink()

    this.recorder.start(CHUNK_MS)
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
      const volume = tile.audioMuted ? 0 : 1
      for (const track of tile.stream?.getAudioTracks() ?? []) {
        const existing = this.mixed.get(track)
        if (existing) {
          existing.gain.gain.value = volume
          continue
        }
        const mixedSource = this.mixSource(ctx, mixer, track, tile.local)
        mixedSource.gain.gain.value = volume
        this.mixed.set(track, mixedSource)
      }
    }
  }

  private connectTranslations(): void {
    for (const mixed of this.translationsMixed) this.disconnectMixed(mixed)
    this.translationsMixed = []
    const ctx = audioContext()
    const mixer = this.mixer
    if (!ctx || !mixer) return
    for (const translation of this.translations) {
      const track = translation.stream.getAudioTracks()[0]
      if (track) this.translationsMixed.push(this.mixSource(ctx, mixer, track, translation.local))
    }
  }


  private mixSource(ctx: AudioContext, mixer: MediaStreamAudioDestinationNode, track: MediaStreamTrack, local: boolean): MixedSource {
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
    const gain = ctx.createGain()
    source.connect(gain).connect(mixer)
    return { track, source, gain, element }
  }

  private disconnectMixed(mixed: MixedSource): void {
    try {
      mixed.source.disconnect()
      mixed.gain.disconnect()
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
    if (this.entries.size === 0) return

    // Mirror the recorder's view: a pinned tile gets the spotlight with
    // the rest in a bottom strip, exactly like the room layout (which
    // also auto-pins screen shares). No pin, uniform grid.
    const pinned = [...this.entries.values()].find((entry) => entry.pinned)
    if (pinned) {
      this.paintSpotlight(pinned)
      return
    }

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

  private paintSpotlight(pinned: RecorderEntry): void {
    const { canvas } = this
    const gap = 8
    const others = [...this.entries.values()].filter((entry) => entry !== pinned)
    const stripHeight = others.length > 0 ? Math.round(canvas.height * 0.18) : 0
    const mainHeight = canvas.height - (stripHeight > 0 ? stripHeight + gap : 0)

    // The pinned cell stays black until frames arrive; the layout does
    // not jump around while it decodes.
    if (pinned.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.drawCover(pinned.video, 0, 0, canvas.width, mainHeight)
      this.drawLabel(pinned.name, 0, 0, canvas.width, mainHeight)
    }

    if (stripHeight === 0) return

    const cellWidth = Math.round((stripHeight * 16) / 9)
    let x = 0
    for (const entry of others) {
      // Overflow clips like the live strip's horizontal scroll.
      if (x >= canvas.width) break
      if (entry.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) continue
      this.drawCover(entry.video, x, canvas.height - stripHeight, cellWidth, stripHeight)
      this.drawLabel(entry.name, x, canvas.height - stripHeight, cellWidth, stripHeight)
      x += cellWidth + gap
    }
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
    this.drawing = false
    window.clearInterval(this.paintTimer)
    this.sink = null
    this.starting = null
    this.storageRoot = null
    for (const mixed of this.mixed.values()) this.disconnectMixed(mixed)
    this.mixed.clear()
    for (const mixed of this.translationsMixed) this.disconnectMixed(mixed)
    this.translationsMixed = []
    this.translations = []
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
