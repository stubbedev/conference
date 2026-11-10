// RoomClient: the browser side of the signaling protocol (see
// internal/sfu) and the WebRTC engine. Each member publishes its camera
// and microphone on one upstream peer connection, a shared screen on a
// second one, and answers one downstream connection per remote source.
// When the room is end-to-end encrypted, encoded frames are transformed
// through the E2EE worker, so the server only ever relays ciphertext.

import { errorText } from '@/lib/errors'
import { unreceived } from '@/lib/received'
import { decryptChat, encryptChat } from '@/lib/roomkeys'
import { parseChatText, Refusals, type Refused } from '@/lib/sealed'
import { settled } from '@/lib/settled'
import { Election } from '@/lib/speech/election'
import { Serial } from '@/lib/speech/serial'
import {
  addCounts,
  countsSince,
  newQualityState,
  nextQuality,
  noCounts,
  preferredLayer,
  type InboundCounters,
  type Layer as LayerName,
  type QualityState,
} from '@/lib/quality'
import {
  cameraLayers,
  cameraSenderParameters,
  codecPreferences,
  screenCodec,
  SCREEN_SHARE_FLUID_MAX_BITRATE,
  SCREEN_SHARE_FPS,
  SIMULCAST_STREAM_MODE,
  type VideoCodec,
  demandParameters,
  LAYER_RIDS,
  SCREEN_CONTENT_HINT,
  SCREEN_LAYER_RIDS,
  screenLayers,
  screenSenderParameters,
} from '@/lib/encodings'
import {
  announcedKinds,
  AUDIO_KIND,
  CAMERA_KIND,
  isAudioKind,
  isTileKind,
  SCREEN_AUDIO_KIND,
  SCREEN_KIND,
  TILE_KINDS,
  translationKind,
  translationLang,
  type TileKind,
  type TrackKind,
} from '@/lib/track-kind'
import {
  parseAnnouncement,
  parseLanguageSet,
  parseRoomMessage,
  PROVIDES_NOTHING,
  sameProvides,
  type LangAnnouncement,
  type LangPrefs,
  type LanguageSet,
  type Provides,
  type Room,
  type RoomMessage,
} from '@/lib/translate/types'

export interface MemberInfo {
  id: string
  short: number
  name: string
  mic: boolean
  cam: boolean
  sharing: boolean
}

export interface ChatMessage {
  id: string
  name: string
  text: string
  ts: number
  mine: boolean
}

export interface RemoteTrack {
  sourceId: string
  stream: MediaStream
  kind: TrackKind
}

export type ModerateAction = 'mute' | 'cam' | 'screen' | 'kick'

/** Simulcast layer of a camera, as the SFU names the encodings. */
export type { Layer } from '@/lib/quality'

/** How often a viewer's own statistics are checked for trouble. */
const QUALITY_SAMPLE_MS = 2000

function streamKey(sourceId: string, kind: TileKind): string {
  return `${sourceId}:${kind}`
}

// The connections a member publishes on, named as the SFU names them. A
// share gets its own: the server answers it without transport-wide
// congestion control and holds its bandwidth estimate up with REMB, so it
// stays high while the screen is still instead of settling on what idling
// sends.
const MEDIA_UP = 'up'
const SCREEN_UP = 'up-screen'
type UpstreamId = typeof MEDIA_UP | typeof SCREEN_UP
const UPSTREAM_IDS: readonly UpstreamId[] = [MEDIA_UP, SCREEN_UP]

function isUpstreamId(pc: string | undefined): pc is UpstreamId {
  return UPSTREAM_IDS.some((id) => id === pc)
}

/** One publishing connection and its chain of serialized offers. */
interface Upstream {
  pc: RTCPeerConnection
  negotiation: Promise<void>
}

/** The connection one source's media arrives on, and what it carries. */
interface Downstream {
  pc: RTCPeerConnection
  /** The kind of each media section, by mid, as the source's latest offer announced it. */
  kinds: Map<string, TrackKind>
  /** The tracks handed out and still received, by mid. */
  tracks: Map<string, RemoteTrack>
}

/**
 * readInboundCounters sums this connection's cumulative video decoder
 * counters per stream, the ones that say trouble has already reached the
 * picture. kindOf names the stream a received track belongs to.
 */
async function readInboundCounters(
  pc: RTCPeerConnection,
  kindOf: (mid: string) => TrackKind | undefined,
): Promise<Map<TileKind, InboundCounters> | null> {
  const mids = new Map<string, string>()
  for (const transceiver of pc.getTransceivers()) {
    if (transceiver.mid !== null) mids.set(transceiver.receiver.track.id, transceiver.mid)
  }

  const counters = new Map<TileKind, InboundCounters>()

  try {
    for (const report of (await pc.getStats()).values()) {
      const entry = report as unknown as Record<string, unknown>
      if (entry.type !== 'inbound-rtp' || entry.kind !== 'video') continue

      const mid = mids.get(String(entry.trackIdentifier))
      const kind = mid === undefined ? undefined : kindOf(mid)
      if (!isTileKind(kind)) continue

      const sum = counters.get(kind) ?? noCounts()
      addCounts(sum, {
        droppedFrames: Number(entry.framesDropped ?? 0),
        decodedFrames: Number(entry.framesDecoded ?? 0),
        lostPackets: Number(entry.packetsLost ?? 0),
        receivedPackets: Number(entry.packetsReceived ?? 0),
      })
      counters.set(kind, sum)
    }
  } catch (err) {
    console.warn('sfu: reading the inbound video counters', err)
    return null
  }

  return counters
}
export type ForcedAction = Exclude<ModerateAction, 'kick'>

export interface RoomClientOptions {
  slug: string
  session: string
  name: string
  mediaKey: Uint8Array<ArrayBuffer>
  chatKey: CryptoKey
  /** Token from an earlier welcome; '' for a first join. */
  resume: string
}

/** Join codes after which retrying cannot succeed. */
const FINAL_JOIN_CODES = new Set(['room-not-found', 'unauthorized'])

/** The WebSocket URL of path on the server this page came from. */
export function serverSocketURL(path: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}${path}`
}

// A page served over HTTPS on a bare IP address is a local-network
// setup (just translate-lan) with a self-signed certificate. Safari opens
// the page after "Proceed" but refuses the WebSocket until the Mac trusts
// the certificate, which then looks like a plain connection failure.
function selfSignedHint(): string {
  if (location.protocol !== 'https:' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(location.hostname)) return ''
  return ` If this is Safari on a local-network link, trust the certificate first: open ${location.origin}/certificate.pem, then in Keychain Access set it to "Always Trust".`
}

export class JoinError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }

  get final(): boolean {
    return FINAL_JOIN_CODES.has(this.code)
  }
}

interface WireMessage {
  type: string
  room?: string
  session?: string
  name?: string
  id?: string
  short?: number
  self?: MemberInfo
  members?: MemberInfo[]
  pc?: string
  sdp?: string
  tracks?: { mid: string; kind: TrackKind }[]
  candidate?: RTCIceCandidateInit
  member?: string
  mic?: boolean
  cam?: boolean
  sharing?: boolean
  from?: string
  iv?: string
  ct?: string
  ts?: number
  code?: string
  text?: string
  target?: string
  action?: string
  on?: boolean
  recorder?: string
  iceServers?: RTCIceServer[]
  resume?: string
  replaces?: string
  kind?: TileKind
  layer?: LayerName
  mid?: string
  active?: unknown
  translatingBy?: string
  token?: string
}

/** A message as it arrives: what it says of tracks is still to be read. */
type ReceivedMessage = Omit<WireMessage, 'tracks'> & { tracks?: unknown }

// What the room's members and their sealed messages are read from. The
// server relays each member's messages in the order that member sent
// them, and opening one takes a turn of the event loop, so these are
// handled one at a time: a member's announcement is known before the
// line that member sent after it.
const ORDERED_TYPES: ReadonlySet<string> = new Set(['member-joined', 'member-left', 'chat', 'lang', 'caption', 'forced'])

interface Events {
  welcome: { self: MemberInfo; members: MemberInfo[]; recorder: string; translatingBy: string }
  'member-joined': { member: MemberInfo; replaces: string }
  'member-left': { id: string }
  /** A member's id will not be heard from again: the member left, or rejoined under a new one. */
  'member-gone': { id: string }
  'member-state': { id: string; mic: boolean; cam: boolean; sharing: boolean }
  /** A track of another member starts arriving. */
  track: RemoteTrack
  /** That track is no longer received: its publisher took it away, or its connection is gone. */
  'track-removed': RemoteTrack
  chat: ChatMessage
  recording: { from: string; on: boolean }
  lang: { from: string; prefs: LangAnnouncement }
  caption: { from: string; caption: RoomMessage }
  translating: { from: string; on: boolean }
  'translate-token': { token: string }
  error: { code: string; text: string }
  forced: { action: ForcedAction }
  /** A host set this member's live-translation language. */
  'lang-set': { from: string; lang: string }
  kicked: Record<string, never>
  closed: Record<string, never>
}

type AnyHandler = (payload: never) => void

// E2EEStats is what the worker posts every couple of seconds: frames
// processed and dropped per direction plus the last error text.
export interface E2EEStats {
  type: 'e2ee-stats'
  send: number
  recv: number
  dropSend: number
  dropRecv: number
  lastError: string
}

function isE2EEStats(data: unknown): data is E2EEStats {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'e2ee-stats'
}

// preferCodec pins a video transceiver to a codec end-to-end encryption
// can carry. H.264 and AV1 packetizers parse NAL units and OBUs out of
// the payload and would choke on ciphertext. The SFU mirrors the offer's
// codec order, so a browser that lists a hardware H.264 encoder first
// would otherwise get it.
function preferCodec(transceiver: RTCRtpTransceiver, codec: VideoCodec): void {
  const preferred = codecPreferences(videoCapabilities(), codec)
  if (preferred.length === 0) return
  transceiver.setCodecPreferences(preferred)
}

function videoCapabilities(): RTCRtpCodec[] {
  return RTCRtpSender.getCapabilities('video')?.codecs ?? []
}

async function sendsVP9Simulcast(track: MediaStreamTrack): Promise<boolean> {
  const { width, height, frameRate } = track.getSettings()
  if (!width || !height) return false
  try {
    const info = await navigator.mediaCapabilities.encodingInfo({
      type: 'webrtc',
      video: {
        contentType: 'video/VP9',
        width,
        height,
        bitrate: SCREEN_SHARE_FLUID_MAX_BITRATE,
        framerate: frameRate ?? SCREEN_SHARE_FPS,
        scalabilityMode: SIMULCAST_STREAM_MODE,
      },
    })
    return info.supported
  } catch (err) {
    console.warn('sfu: asking whether the fluid share layer can be encoded', err)
    return false
  }
}

// tuneScreenSender applies the screen-share encoding. A browser that
// refuses the parameters still shares its screen at its own defaults,
// which beats failing the share over a hint.
async function tuneScreenSender(sender: RTCRtpSender): Promise<void> {
  try {
    await sender.setParameters(screenSenderParameters(sender.getParameters()))
  } catch (err) {
    console.warn('sfu: tuning the screen-share encoder', err)
  }
}

export class RoomClient {
  private ws: WebSocket | null = null
  private opts: RoomClientOptions
  private ups = new Map<UpstreamId, Upstream>()
  private downs = new Map<string, Downstream>()
  private pendingIce = new Map<string, RTCIceCandidateInit[]>()
  private members = new Map<string, MemberInfo>()
  private translationTrackLangs = new Map<string, string>()
  private translationSenders: RTCRtpSender[] = []
  private langPrefs: LangPrefs | null = null
  private memberLangs = new Map<string, LangAnnouncement>()
  private refusals = new Refusals((line, ...detail) => console.warn(`sfu: ${line}`, ...detail))
  private sealing = new Serial()
  private opening = new Serial()
  private provides: Provides = PROVIDES_NOTHING
  private election = new Election()
  private room: Room = {
    inCall: (member) => member === this.selfId || this.members.has(member),
    translated: (member, lang, speaker, segId) => this.election.translated(member, lang, speaker, segId),
  }
  private transformed = new WeakSet<object>()
  private selfId = ''
  private iceServers: RTCIceServer[] | null = null
  private resumeToken = ''
  private layerPrefs = new Map<string, LayerName>()
  private layoutLayers = new Map<string, LayerName>()
  private quality = new Map<string, QualityState>()
  private inbound = new Map<string, InboundCounters>()
  private qualityTimer = 0
  private closing = false
  private handlers = new Map<string, Set<AnyHandler>>()
  private localMic: MediaStreamTrack | null = null
  private localCam: MediaStreamTrack | null = null
  private micSender: RTCRtpSender | null = null
  private camSender: RTCRtpSender | null = null
  private retuning: Promise<void> = Promise.resolve()
  private state = { mic: true, cam: true, sharing: false }
  private e2eeStats: E2EEStats | null = null
  private e2eeFailureReported = { send: false, recv: false }

  readonly worker: Worker

  constructor(opts: RoomClientOptions) {
    this.opts = opts
    this.worker = new Worker(new URL('./e2ee.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (ev: MessageEvent<unknown>) => {
      if (!isE2EEStats(ev.data)) return
      this.e2eeStats = ev.data
      this.reportE2EEFailure(ev.data)
    }
    this.worker.onerror = (ev: ErrorEvent) => {
      this.emit('error', { code: 'e2ee', text: `Media encryption worker failed: ${ev.message}` })
    }
    this.worker.postMessage({ keyBytes: opts.mediaKey.slice() })
  }

  // reportE2EEFailure turns a transform that drops everything into a
  // visible error. A silently failing transform looks exactly like a
  // network problem from the outside (call connected, tiles black), so
  // the first direction that has only ever dropped frames is reported
  // once, with the worker's own error text.
  private reportE2EEFailure(stats: E2EEStats): void {
    if (!this.e2eeFailureReported.send && stats.dropSend > 0 && stats.send === 0) {
      this.e2eeFailureReported.send = true
      this.emit('error', {
        code: 'e2ee',
        text: `Your media cannot be encrypted, nothing is being sent: ${stats.lastError}`,
      })
    }
    if (!this.e2eeFailureReported.recv && stats.dropRecv > 0 && stats.recv === 0) {
      this.e2eeFailureReported.recv = true
      this.emit('error', {
        code: 'e2ee',
        text: `Incoming media cannot be decrypted: ${stats.lastError}`,
      })
    }
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(serverSocketURL('/ws'))
      this.ws = ws

      const timeout = setTimeout(() => reject(new JoinError('timeout', 'Join timed out.')), 15_000)

      ws.onopen = () => {
        this.send({
          type: 'join',
          room: this.opts.slug,
          session: this.opts.session,
          name: this.opts.name,
          resume: this.opts.resume || undefined,
        })
      }
      ws.onmessage = (ev) => {
        let msg: ReceivedMessage
        try {
          msg = JSON.parse(ev.data as string) as ReceivedMessage
        } catch (err) {
          console.warn('sfu: a signalling message that is not JSON', err)
          return
        }
        if (msg.type === 'welcome') {
          clearTimeout(timeout)
          if (!msg.iceServers?.length) {
            reject(new JoinError('protocol', 'The server sent no ICE servers.'))
            return
          }
          this.iceServers = msg.iceServers
          this.resumeToken = msg.resume ?? ''
          if (msg.self) this.selfId = msg.self.id
          this.elect()
          for (const member of msg.members ?? []) this.members.set(member.id, member)
          this.emit('welcome', {
            self: msg.self as MemberInfo,
            members: msg.members ?? [],
            recorder: msg.recorder ?? '',
            translatingBy: msg.translatingBy ?? '',
          })
          resolve()
          void this.sendLang()
          return
        }
        if (msg.type === 'error') {
          clearTimeout(timeout)
          reject(new JoinError(msg.code ?? '', msg.text ?? 'The room rejected the join.'))
          this.emit('error', { code: msg.code ?? '', text: msg.text ?? '' })
          return
        }
        void this.receive(msg)
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        reject(new JoinError('network', `Signaling connection failed.${selfSignedHint()}`))
      }
      ws.onclose = () => {
        clearTimeout(timeout)
        reject(new JoinError('network', 'The signaling connection closed.'))
        if (!this.closing) this.emit('closed', {})
      }
    })
  }

  on<K extends keyof Events>(type: K, handler: (payload: Events[K]) => void): () => void {
    const set = this.handlers.get(type) ?? new Set()
    set.add(handler as AnyHandler)
    this.handlers.set(type, set)
    return () => set.delete(handler as AnyHandler)
  }

  get memberId(): string {
    return this.selfId
  }

  /** Rejoin token for replacing this membership after a dropped connection. */
  get resume(): string {
    return this.resumeToken
  }

  /** Language settings other members have announced so far. */
  get memberLangPrefs(): ReadonlyMap<string, LangAnnouncement> {
    return this.memberLangs
  }

  /** The member the room holds as the translator into each language that has one. */
  get translators(): ReadonlyMap<string, string> {
    return this.election.translators
  }

  translatorFor(lang: string): string | null {
    return this.election.translatorFor(lang)
  }

  memberName(id: string): string {
    if (id === this.selfId) return this.opts.name
    return this.members.get(id)?.name ?? 'Guest'
  }

  async publish(stream: MediaStream): Promise<void> {
    const pc = this.openUp(MEDIA_UP)

    this.localMic = stream.getAudioTracks()[0] ?? null
    this.localCam = stream.getVideoTracks()[0] ?? null
    this.micSender = this.localMic ? pc.addTrack(this.localMic, stream) : null
    this.camSender = this.localCam ? this.addCamera(pc, this.localCam, stream) : null

    for (const sender of pc.getSenders()) this.installSenderTransform(sender)
    if (pc.getSenders().length > 0) await this.sendUpOffer(MEDIA_UP)

    this.state = {
      mic: this.localMic?.enabled ?? false,
      cam: this.localCam?.enabled ?? false,
      sharing: false,
    }
    this.sendState()
  }

  // addScreen publishes a share on a connection of its own. A share
  // carries its own sound when the picker offered it; everything on this
  // connection is announced as the screen or its audio, so the server
  // treats the sound as audio and every member hears what is shared.
  async addScreen(stream: MediaStream): Promise<void> {
    if (!this.ups.has(MEDIA_UP)) throw new Error('Publish before sharing your screen.')
    if (this.ups.has(SCREEN_UP)) throw new Error('A screen is already being shared.')

    const pc = this.openUp(SCREEN_UP)
    try {
      for (const track of stream.getTracks()) {
        const sender = track.kind === 'video' ? await this.addScreenVideo(pc, track, stream) : pc.addTrack(track, stream)
        this.installSenderTransform(sender)

        if (track.kind === 'video') await tuneScreenSender(sender)
      }
      await this.sendUpOffer(SCREEN_UP)
    } catch (err) {
      this.dropScreen()
      throw err
    }

    this.state = { ...this.state, sharing: true }
    void this.tuneCamera()
    this.sendState()
  }

  async removeScreen(): Promise<void> {
    if (!this.dropScreen()) return

    this.state = { ...this.state, sharing: false }
    void this.tuneCamera()
    this.sendState()
  }

  /** Closes the share's connection on both ends; reports whether it was open. */
  private dropScreen(): boolean {
    if (!this.closeUp(SCREEN_UP)) return false
    this.send({ type: 'close', pc: SCREEN_UP })
    return true
  }

  private openUp(id: UpstreamId): RTCPeerConnection {
    const pc = this.newPC(id)
    this.ups.set(id, { pc, negotiation: Promise.resolve() })
    return pc
  }

  /** Closes one publishing connection; reports whether it was open. */
  private closeUp(id: UpstreamId): boolean {
    const up = this.ups.get(id)
    if (!up) return false

    this.ups.delete(id)
    this.pendingIce.delete(id)
    up.pc.close()
    return true
  }

  private closeUps(): void {
    for (const id of UPSTREAM_IDS) this.closeUp(id)
  }

  // tuneCamera retunes the camera's encodings in place for the track it
  // sends and whether a screen is shared. A browser that refuses the
  // parameters keeps its own caps, which is a worse picture, never a
  // broken one.
  private tuneCamera(): Promise<void> {
    const sender = this.camSender
    const track = sender?.track
    if (!sender || !track) return Promise.resolve()

    const layers = cameraLayers(track.getSettings())
    return this.retune(sender, 'tuning the camera encoder', (parameters) =>
      cameraSenderParameters(parameters, layers, this.state.sharing),
    )
  }

  private demandLayers(up: UpstreamId, mid: string, active: boolean[]): void {
    const sender = this.ups.get(up)?.pc.getTransceivers().find((transceiver) => transceiver.mid === mid)?.sender
    if (!sender) return
    void this.retune(sender, 'pausing and resuming simulcast layers', (parameters) => demandParameters(parameters, active))
  }

  private retune(sender: RTCRtpSender, doing: string, change: (parameters: RTCRtpSendParameters) => RTCRtpSendParameters): Promise<void> {
    const next = this.retuning.then(() => sender.setParameters(change(sender.getParameters())))
    this.retuning = next.catch((err: unknown) => console.warn(`sfu: ${doing}`, err))
    return this.retuning
  }

  async replaceLocalTrack(kind: 'mic' | 'cam', track: MediaStreamTrack): Promise<void> {
    const pc = this.ups.get(MEDIA_UP)?.pc
    if (!pc) return

    let sender = kind === 'mic' ? this.micSender : this.camSender
    if (!sender) {
      const stream = new MediaStream([track])
      sender = kind === 'mic' ? pc.addTrack(track, stream) : this.addCamera(pc, track, stream)
      this.installSenderTransform(sender)
      if (kind === 'mic') this.micSender = sender
      else this.camSender = sender
      await this.sendUpOffer(MEDIA_UP)
    } else {
      await sender.replaceTrack(track)
      if (kind === 'cam') await this.tuneCamera()
    }

    if (kind === 'mic') this.localMic = track
    else this.localCam = track
  }

  /** Tells the SFU the highest layer this page's layout can use for a source's camera or screen. */
  preferLayer(sourceId: string, kind: TileKind, layer: LayerName): void {
    const key = streamKey(sourceId, kind)
    if (this.layoutLayers.get(key) === layer) return

    this.layoutLayers.set(key, layer)

    const quality = this.quality.get(key) ?? newQualityState()
    this.quality.set(key, quality)
    this.requestLayer(sourceId, kind, preferredLayer(layer, quality.ceiling))
  }

  private requestLayer(sourceId: string, kind: TileKind, layer: LayerName): void {
    const key = streamKey(sourceId, kind)
    if (this.layerPrefs.get(key) === layer) return

    this.layerPrefs.set(key, layer)
    this.send({ type: 'layer', member: sourceId, kind, layer })
  }

  // watchQuality samples every downstream connection and lets each viewer's
  // own decoder statistics move the layer it asks for, before the stall is
  // on screen. The SFU keeps its own loss-driven ladder; this only ever
  // lowers or restores the ceiling on top of it.
  private startQualityWatch(): void {
    if (this.qualityTimer) return

    this.qualityTimer = window.setInterval(() => void this.sampleQuality(), QUALITY_SAMPLE_MS)
  }

  private stopQualityWatch(): void {
    window.clearInterval(this.qualityTimer)
    this.qualityTimer = 0
  }

  private async sampleQuality(): Promise<void> {
    for (const [sourceId, down] of this.downs) {
      const streams = await readInboundCounters(down.pc, (mid) => down.kinds.get(mid))
      if (!streams) continue

      for (const [kind, counters] of streams) this.stepQuality(sourceId, kind, counters)
    }
  }

  private stepQuality(sourceId: string, kind: TileKind, counters: InboundCounters): void {
    const key = streamKey(sourceId, kind)
    const previous = this.inbound.get(key)
    this.inbound.set(key, counters)

    const layout = this.layoutLayers.get(key)
    if (!previous || !layout) return

    const quality = this.quality.get(key) ?? newQualityState()
    const rungs = kind === SCREEN_KIND ? SCREEN_LAYER_RIDS : LAYER_RIDS
    const stepped = nextQuality(quality, layout, countsSince(previous, counters), rungs)
    this.quality.set(key, stepped)

    if (stepped.ceiling !== quality.ceiling) {
      this.requestLayer(sourceId, kind, preferredLayer(layout, stepped.ceiling))
    }
  }

  setTrackEnabled(kind: 'mic' | 'cam', enabled: boolean): void {
    const track = kind === 'mic' ? this.localMic : this.localCam
    if (track) track.enabled = enabled
    const on = track !== null && enabled
    this.state = kind === 'mic' ? { ...this.state, mic: on } : { ...this.state, cam: on }
    this.sendState()
  }

  get currentState(): { mic: boolean; cam: boolean; sharing: boolean } {
    return this.state
  }

  sendChat(text: string): Promise<void> {
    return this.sendSealed({ type: 'chat' }, text)
  }

  /** Sets and announces this member's language settings; re-sent to every joiner. */
  setLangPrefs(prefs: LangPrefs): void {
    this.langPrefs = prefs
    this.elect()
    void this.sendLang()
  }

  /** Sets and announces what this member's translator does for the room right now. */
  setProvides(provides: Provides): void {
    if (sameProvides(this.provides, provides)) return
    this.provides = provides
    this.elect()
    void this.sendLang()
  }

  // announceTranslating switches the room's live translation on or off
  // (hosts only). While it is on, the server hands every member a
  // translate-token event for the speech service.
  announceTranslating(on: boolean): void {
    this.send({ type: 'translate', on })
  }

  /** Asks for a fresh speech token; answered only while translation is on. */
  requestSpeechToken(): void {
    this.send({ type: 'translate-token-request' })
  }

  sendCaption(caption: RoomMessage): Promise<void> {
    if (caption.k === 'caption') this.election.hear(caption.speaker, caption.segId)
    return this.sendSealed({ type: 'caption' }, JSON.stringify(caption))
  }

  /** Publishes a translated-voice track, labelled translation-<lang> for the room. */
  async addTranslationTrack(lang: string, track: MediaStreamTrack): Promise<void> {
    const pc = this.ups.get(MEDIA_UP)?.pc
    if (!pc) throw new Error('Publish before adding a translation track.')

    this.translationTrackLangs.set(track.id, lang)
    const sender = pc.addTrack(track, new MediaStream([track]))
    this.translationSenders.push(sender)
    this.installSenderTransform(sender)
    await this.sendUpOffer(MEDIA_UP)
  }

  async removeTranslationTracks(): Promise<void> {
    const pc = this.ups.get(MEDIA_UP)?.pc
    if (!pc || this.translationSenders.length === 0) return

    for (const sender of this.translationSenders) {
      try {
        pc.removeTrack(sender)
      } catch (err) {
        console.warn('removeTrack', err)
      }
    }
    this.translationSenders = []
    this.translationTrackLangs.clear()
    await this.sendUpOffer(MEDIA_UP)
  }

  moderate(target: string, action: ModerateAction): void {
    this.send({ type: 'moderate', target, action })
  }

  /** Sets another member's live-translation language (host only); sealed like their own. */
  setMemberLanguage(target: string, lang: string): Promise<void> {
    const set: LanguageSet = { lang }
    return this.sendSealed({ type: 'moderate', target, action: 'lang' }, JSON.stringify(set))
  }

  // announceRecording claims (or releases) the room's recording badge.
  // The server arbitrates: one recorder at a time, cleared if the
  // recorder drops. The denial arrives as an error event.
  announceRecording(on: boolean): void {
    this.send({ type: 'record', on })
  }

  leave(): void {
    this.closing = true
    this.stopQualityWatch()
    this.ws?.close()
    this.closeUps()
    for (const sourceId of [...this.downs.keys()]) this.closeDown(sourceId)
    this.worker.terminate()
  }

  /**
   * pause gives up the connection and the upstream, but holds on to the
   * downstream connections: the call's pictures stay on screen while a
   * replacement negotiates underneath, which is the difference between a
   * blip and a black screen. destroy releases what was held.
   */
  pause(): void {
    this.closing = true
    this.ws?.close()
    this.closeUps()
  }

  destroy(): void {
    this.leave()
  }

  private send(msg: WireMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(msg))
  }

  // Sealing takes a turn of the event loop too, so what is sealed for
  // the room leaves one at a time, in the order it was handed over.
  private sendSealed(message: WireMessage, text: string): Promise<void> {
    return this.sealing.run(async () => {
      const sealed = await encryptChat(this.opts.chatKey, text)
      this.send({ ...message, iv: sealed.iv, ct: sealed.ct })
    })
  }

  // This member stands with what it announces, from the moment it knows
  // the id the room knows it by.
  private elect(): void {
    const others = [...this.memberLangs].map(([id, prefs]) => ({ id, lang: prefs.lang, translates: prefs.translates }))
    const self = this.langPrefs && this.selfId ? [{ id: this.selfId, lang: this.langPrefs.lang, translates: this.provides.translates }] : []
    this.election.hold([...others, ...self])
  }

  private async sendLang(): Promise<void> {
    if (!this.langPrefs) return
    const announcement: LangAnnouncement = { ...this.langPrefs, ...this.provides }
    await this.sendSealed({ type: 'lang' }, JSON.stringify(announcement))
  }

  private sendState(): void {
    this.send({
      type: 'state',
      mic: this.state.mic,
      cam: this.state.cam,
      sharing: this.state.sharing,
    })
  }

  private emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    for (const handler of this.handlers.get(type) ?? []) {
      ;(handler as (p: Events[K]) => void)(payload)
    }
  }

  private newPC(pcID: string): RTCPeerConnection {
    if (!this.iceServers) throw new Error(`Peer connection ${pcID} opened before the welcome.`)
    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    // A failed peer connection does not recover on its own (the
    // network changed, the path died); dropping signaling hands the
    // whole session to the caller's reconnect, the one recovery path.
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' && !this.closing) this.ws?.close()
    }
    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return
      this.send({ type: 'ice', pc: pcID, candidate: ev.candidate.toJSON() })
    }
    return pc
  }

  // The encoded transform is attached through the standard
  // RTCRtpScriptTransform API only. Room.tsx refuses to join without
  // it, so no untyped fallback path exists here.
  private installSenderTransform(sender: RTCRtpSender): void {
    if (this.transformed.has(sender)) return
    this.transformed.add(sender)
    sender.transform = new RTCRtpScriptTransform(this.worker, { purpose: 'send' })
  }

  private installReceiverTransform(receiver: RTCRtpReceiver): void {
    if (this.transformed.has(receiver)) return
    this.transformed.add(receiver)
    receiver.transform = new RTCRtpScriptTransform(this.worker, { purpose: 'recv' })
  }

  private async addScreenVideo(pc: RTCPeerConnection, track: MediaStreamTrack, stream: MediaStream): Promise<RTCRtpSender> {
    track.contentHint = SCREEN_CONTENT_HINT
    const codec = screenCodec(videoCapabilities(), await sendsVP9Simulcast(track))
    const transceiver = pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [stream],
      sendEncodings: screenLayers(codec),
    })
    preferCodec(transceiver, codec)
    return transceiver.sender
  }

  private addCamera(pc: RTCPeerConnection, track: MediaStreamTrack, stream: MediaStream): RTCRtpSender {
    const transceiver = pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [stream],
      sendEncodings: cameraLayers(track.getSettings()),
    })
    preferCodec(transceiver, 'VP8')
    return transceiver.sender
  }

  // Offers are serialized per connection: a second
  // createOffer/setLocalDescription overlapping the first (two
  // translation tracks added at once) makes Chrome reject the
  // description as modified.
  private sendUpOffer(id: UpstreamId): Promise<void> {
    const up = this.ups.get(id)
    if (!up) return Promise.reject(new Error(`Offer on ${id}, which is not open.`))

    const next = up.negotiation.then(() => this.negotiateUp(id, up.pc))
    up.negotiation = settled(next)
    return next
  }

  private async negotiateUp(id: UpstreamId, pc: RTCPeerConnection): Promise<void> {
    if (this.ups.get(id)?.pc !== pc) return

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    const tracks = pc
      .getTransceivers()
      .filter((t) => t.sender.track && t.mid)
      .map((t) => ({ mid: t.mid as string, kind: this.kindOf(id, t.sender.track as MediaStreamTrack) }))

    this.send({ type: 'offer', pc: id, sdp: pc.localDescription?.sdp ?? '', tracks })
  }

  private kindOf(id: UpstreamId, track: MediaStreamTrack): TrackKind {
    if (id === SCREEN_UP) return track.kind === 'audio' ? SCREEN_AUDIO_KIND : SCREEN_KIND
    const translationLang = this.translationTrackLangs.get(track.id)
    if (translationLang) return translationKind(translationLang)
    if (track.kind === 'audio') return AUDIO_KIND
    return CAMERA_KIND
  }

  private receive(msg: ReceivedMessage): Promise<void> {
    return ORDERED_TYPES.has(msg.type) ? this.opening.run(() => this.handle(msg)) : this.handle(msg)
  }

  private async handle(msg: ReceivedMessage): Promise<void> {
    switch (msg.type) {
      case 'answer': {
        const pc = isUpstreamId(msg.pc) ? this.ups.get(msg.pc)?.pc : undefined
        if (pc && msg.pc && msg.sdp) {
          await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
          this.flushIce(msg.pc, pc)
        }
        return
      }
      case 'offer':
        if (msg.pc?.startsWith('down-') && msg.sdp) {
          await this.handleDownOffer(msg.pc.slice('down-'.length), msg)
        }
        return
      case 'ice':
        this.handleIce(msg)
        return
      case 'member-joined': {
        if (msg.id) {
          const member: MemberInfo = {
            id: msg.id,
            short: msg.short ?? 0,
            name: msg.name ?? 'Guest',
            mic: false,
            cam: false,
            sharing: false,
          }
          const replaces = msg.replaces ?? ''
          if (replaces) this.dropMember(replaces)
          this.members.set(member.id, member)
          this.emit('member-joined', { member, replaces })
          void this.sendLang()
        }
        return
      }
      case 'member-left':
        // A member replaced by its own rejoin was already dropped when
        // the replacement arrived; its late departure is not news.
        if (msg.id && this.dropMember(msg.id)) this.emit('member-left', { id: msg.id })
        return
      case 'member-state':
        if (msg.id) {
          const member = this.members.get(msg.id)
          if (member) {
            member.mic = msg.mic ?? member.mic
            member.cam = msg.cam ?? member.cam
            member.sharing = msg.sharing ?? member.sharing
          }
          this.emit('member-state', {
            id: msg.id,
            mic: msg.mic ?? false,
            cam: msg.cam ?? false,
            sharing: msg.sharing ?? false,
          })
        }
        return
      case 'chat': {
        const what = 'a chat message'
        const opened = await this.openSealed(msg, what)
        if (!opened) return

        const chat = this.read(what, opened.from, parseChatText(opened.text))
        if (!chat) return
        if (msg.ts === undefined) {
          this.refusals.report(what, opened.from, 'the server gave it no time')
          return
        }
        this.emit('chat', { id: `${opened.from}:${msg.ts}`, name: this.memberName(opened.from), text: chat.text, ts: msg.ts, mine: false })
        return
      }
      case 'recording':
        if (msg.from) this.emit('recording', { from: msg.from, on: msg.on ?? false })
        return
      case 'lang': {
        const what = 'a language announcement'
        const opened = await this.openSealedJSON(msg, what)
        if (!opened) return

        const { from } = opened
        const prefs = this.read(what, from, parseAnnouncement(opened.value))
        if (!prefs) return
        this.memberLangs.set(from, prefs)
        this.elect()
        this.emit('lang', { from, prefs })
        return
      }
      case 'caption': {
        const what = 'a caption or translation'
        const opened = await this.openSealedJSON(msg, what)
        if (!opened) return

        const { from } = opened
        const caption = this.read(what, from, parseRoomMessage(opened.value, from, this.room))
        if (!caption) return
        if (caption.k === 'caption') this.election.hear(caption.speaker, caption.segId)
        this.emit('caption', { from, caption })
        return
      }
      case 'translating':
        if (msg.from) this.emit('translating', { from: msg.from, on: msg.on ?? false })
        return
      case 'translate-token':
        if (msg.token) this.emit('translate-token', { token: msg.token })
        return
      case 'forced': {
        const action = msg.action
        if (action === 'mute' || action === 'cam' || action === 'screen') {
          this.emit('forced', { action })
        } else if (action === 'lang') {
          const what = 'a language set by a host'
          const opened = await this.openSealedJSON(msg, what)
          if (!opened) return

          const { from } = opened
          const set = this.read(what, from, parseLanguageSet(opened.value))
          if (set) this.emit('lang-set', { from, lang: set.lang })
        }
        return
      }
      case 'kicked':
        this.emit('kicked', {})
        return
      case 'layers': {
        const active = msg.active
        if (!isUpstreamId(msg.pc) || typeof msg.mid !== 'string' || !Array.isArray(active)) return
        if (active.length !== LAYER_RIDS.length || !active.every((value) => typeof value === 'boolean')) return
        this.demandLayers(msg.pc, msg.mid, active as boolean[])
        return
      }
      default:
        return
    }
  }

  /** Forgets a member and closes its downstream; reports whether it was known. */
  private dropMember(id: string): boolean {
    for (const kind of TILE_KINDS) {
      const key = streamKey(id, kind)
      this.layerPrefs.delete(key)
      this.layoutLayers.delete(key)
      this.quality.delete(key)
      this.inbound.delete(key)
    }
    if (this.memberLangs.delete(id)) this.elect()
    const known = this.members.delete(id)
    this.closeDown(id)
    if (known) this.emit('member-gone', { id })
    return known
  }

  private openDown(sourceId: string): Downstream {
    const down: Downstream = { pc: this.newPC(`down-${sourceId}`), kinds: new Map(), tracks: new Map() }
    this.downs.set(sourceId, down)
    this.startQualityWatch()
    down.pc.ontrack = (ev) => {
      this.installReceiverTransform(ev.receiver)
      const mid = ev.transceiver.mid
      const kind = mid === null ? undefined : down.kinds.get(mid)
      if (mid === null || kind === undefined || isAudioKind(kind) !== (ev.track.kind === 'audio')) {
        console.warn(
          `sfu: dropping the ${ev.track.kind} track in section ${mid} from ${sourceId}: announced as ${kind ?? 'no kind this client knows'}`,
        )
        return
      }
      // A translated voice and a share's sound are played on their own
      // terms, never as part of the speaker's camera stream, so each
      // gets a stream of its own.
      const stream =
        translationLang(kind) !== null || kind === SCREEN_AUDIO_KIND
          ? new MediaStream([ev.track])
          : (ev.streams[0] ?? new MediaStream([ev.track]))
      const track: RemoteTrack = { sourceId, stream, kind }
      down.tracks.set(mid, track)
      this.emit('track', track)
    }
    return down
  }

  /** Closes the connection a source's media arrives on; every track it carried goes with it. */
  private closeDown(sourceId: string): void {
    const down = this.downs.get(sourceId)
    if (!down) return

    this.downs.delete(sourceId)
    down.pc.close()
    this.removeTracks(down, [...down.tracks])
  }

  private removeTracks(down: Downstream, gone: readonly [string, RemoteTrack][]): void {
    for (const [mid, track] of gone) {
      down.tracks.delete(mid)
      this.emit('track-removed', track)
    }
  }

  private async handleDownOffer(sourceId: string, msg: ReceivedMessage): Promise<void> {
    const down = this.downs.get(sourceId) ?? this.openDown(sourceId)
    const { pc } = down

    const { kinds, refused } = announcedKinds(msg.tracks)
    down.kinds = kinds
    for (const entry of refused) console.warn(`sfu: ${sourceId} announced a track this client cannot place:`, entry)

    await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp ?? '' })
    this.flushIce(`down-${sourceId}`, pc)

    for (const receiver of pc.getReceivers()) this.installReceiverTransform(receiver)

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    // Only the answered offer says which sections the source still sends
    // on: a track taken away neither ends nor leaves a stream of its own.
    this.removeTracks(down, unreceived(down.tracks, pc.getTransceivers()))

    this.send({ type: 'answer', pc: `down-${sourceId}`, sdp: pc.localDescription?.sdp ?? '' })
    this.send({ type: 'pli', member: sourceId })
  }

  private handleIce(msg: ReceivedMessage): void {
    if (!msg.candidate || !msg.pc) return

    const id = msg.pc
    const pc = isUpstreamId(id) ? this.ups.get(id)?.pc : this.downs.get(id.slice('down-'.length))?.pc
    // A publishing connection exists before the server learns of it, so a
    // candidate for one that is gone trails its close and has nowhere to go.
    if (isUpstreamId(id) && !pc) return
    if (!pc || !pc.remoteDescription) {
      const queue = this.pendingIce.get(msg.pc) ?? []
      queue.push(msg.candidate)
      this.pendingIce.set(msg.pc, queue)
      return
    }

    pc.addIceCandidate(msg.candidate).catch((err) => console.warn('ice', err))
  }

  private flushIce(pcId: string, pc: RTCPeerConnection): void {
    const queue = this.pendingIce.get(pcId)
    if (!queue) return

    this.pendingIce.delete(pcId)
    for (const candidate of queue) {
      pc.addIceCandidate(candidate).catch((err) => console.warn('ice', err))
    }
  }

  /** What a parser read, or nothing once the reason it refused is logged. */
  private read<T extends object>(what: string, from: string, parsed: T | Refused): T | undefined {
    if (!('refused' in parsed)) return parsed
    this.refusals.report(what, from, parsed.refused)
    return undefined
  }

  /**
   * The text a member of the call sealed in msg, and who that member is.
   * Nothing, with the reason logged, when msg names no member of the
   * call or cannot be opened with the room's key.
   */
  private async openSealed(msg: ReceivedMessage, what: string): Promise<{ from: string; text: string } | undefined> {
    const { from, iv, ct } = msg
    if (!from || !this.members.has(from)) {
      this.refusals.report(what, from || 'nobody', 'its sender is not in the call')
      return undefined
    }
    if (!iv || !ct) {
      this.refusals.report(what, from, 'it carries nothing sealed')
      return undefined
    }
    try {
      return { from, text: await decryptChat(this.opts.chatKey, { iv, ct }) }
    } catch (err) {
      this.refusals.report(what, from, 'it cannot be opened with the room key', err)
      return undefined
    }
  }

  private async openSealedJSON(msg: ReceivedMessage, what: string): Promise<{ from: string; value: unknown } | undefined> {
    const opened = await this.openSealed(msg, what)
    if (!opened) return undefined
    try {
      return { from: opened.from, value: JSON.parse(opened.text) as unknown }
    } catch (err) {
      this.refusals.report(what, opened.from, 'it is not JSON', err)
      return undefined
    }
  }

  // debugStats renders a compact diagnostic snapshot: E2EE worker frame
  // counters plus WebRTC transport statistics for every peer connection.
  // Built to be read from the debug overlay on a phone screen.
  async debugStats(): Promise<string> {
    const lines: string[] = [
      `e2ee ${this.e2eeStats ? JSON.stringify(this.e2eeStats) : 'no stats yet'}`,
      `self ${this.selfId || '-'}`,
    ]

    const connections: [string, RTCPeerConnection][] = []
    for (const [id, up] of this.ups) connections.push([id, up.pc])
    for (const [id, down] of this.downs) connections.push([`down-${id.slice(0, 6)}`, down.pc])

    for (const [label, pc] of connections) {
      try {
        const stats = await pc.getStats()
        for (const report of stats.values()) {
          const entry = report as unknown as Record<string, unknown>
          if (entry.type === 'inbound-rtp' && entry.kind === 'video') {
            lines.push(
              `${label} in/v rx:${entry.framesReceived ?? '?'} dec:${entry.framesDecoded ?? '?'} frz:${entry.freezeCount ?? '?'} pli:${entry.pliCount ?? '?'} nack:${entry.nackCount ?? '?'} loss:${entry.packetsLost ?? '?'}`,
            )
          }
          if (entry.type === 'outbound-rtp' && entry.kind === 'video') {
            lines.push(
              `${label} out/v enc:${entry.framesEncoded ?? '?'} kb:${Math.round(Number(entry.bytesSent ?? 0) / 1024)}`,
            )
          }
          if (entry.type === 'candidate-pair' && entry.state === 'succeeded') {
            lines.push(
              `${label} ice rtt:${Math.round(Number(entry.currentRoundTripTime ?? 0) * 1000)}ms`,
            )
          }
        }
      } catch (err) {
        lines.push(`${label} stats unavailable: ${errorText(err)}`)
      }
    }

    return lines.join('\n')
  }
}
