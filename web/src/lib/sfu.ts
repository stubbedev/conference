// RoomClient: the browser side of the signaling protocol (see
// internal/sfu) and the WebRTC engine. Each member publishes one
// upstream peer connection and answers one downstream connection per
// remote source. When the room is end-to-end encrypted, encoded frames
// are transformed through the E2EE worker, so the server only ever
// relays ciphertext.

import { decryptChat, encryptChat } from '@/lib/roomkeys'
import {
  newQualityState,
  nextQuality,
  preferredLayer,
  since,
  type InboundCounters,
  type Layer as LayerName,
  type QualityState,
} from '@/lib/quality'
import { cameraLayers, relayerParameters, screenSenderParameters, sharingLayers } from '@/lib/encodings'
import { SCREEN_AUDIO_KIND } from '@/lib/screen'
import { announcement, isRoomMessage, type LangAnnouncement, type LangPrefs, type RoomMessage, type TranslationLevel } from '@/lib/translate/types'

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
  kind: string
}

export type ModerateAction = 'mute' | 'cam' | 'screen' | 'kick'

/** Simulcast layer of a camera, as the SFU names the encodings. */
export type { Layer } from '@/lib/quality'

/** How often a viewer's own statistics are checked for trouble. */
const QUALITY_SAMPLE_MS = 2000

/**
 * readInboundCounters sums this connection's cumulative video decoder
 * counters, the ones that say trouble has already reached the picture.
 */
async function readInboundCounters(pc: RTCPeerConnection): Promise<InboundCounters | null> {
  let seen = false
  const counters: InboundCounters = { droppedFrames: 0, lostPackets: 0 }

  try {
    for (const report of (await pc.getStats()).values()) {
      const entry = report as unknown as Record<string, unknown>
      if (entry.type !== 'inbound-rtp' || entry.kind !== 'video') continue

      seen = true
      counters.droppedFrames += Number(entry.framesDropped ?? 0)
      counters.lostPackets += Number(entry.packetsLost ?? 0)
    }
  } catch {
    return null
  }

  return seen ? counters : null
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
  tracks?: { mid: string; kind: string }[]
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
  layer?: LayerName
  translatingBy?: string
  token?: string
}

interface Events {
  welcome: { self: MemberInfo; members: MemberInfo[]; recorder: string; translatingBy: string }
  'member-joined': { member: MemberInfo; replaces: string }
  'member-left': { id: string }
  'member-state': { id: string; mic: boolean; cam: boolean; sharing: boolean }
  track: RemoteTrack
  'track-removed': { sourceId: string; mid: string }
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

// preferVP8 pins a video transceiver to VP8. The E2EE transform keeps
// only the VP8 frame header in the clear; H.264 and AV1 packetizers
// parse NAL units and OBUs out of the payload and would choke on
// ciphertext. The SFU mirrors the offer's codec order, so a browser
// that lists a hardware H.264 encoder first would otherwise get it.
function preferVP8(transceiver: RTCRtpTransceiver): void {
  if (transceiver.sender.track?.kind !== 'video') return
  const codecs = RTCRtpSender.getCapabilities('video')?.codecs ?? []
  const preferred = codecs.filter(
    (codec) => codec.mimeType === 'video/VP8' || codec.mimeType === 'video/rtx',
  )
  if (!preferred.some((codec) => codec.mimeType === 'video/VP8')) return
  transceiver.setCodecPreferences(preferred)
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
  private up: RTCPeerConnection | null = null
  private downs = new Map<string, RTCPeerConnection>()
  private pendingIce = new Map<string, RTCIceCandidateInit[]>()
  private members = new Map<string, MemberInfo>()
  private downKinds = new Map<string, string>()
  private screenTrackIds = new Set<string>()
  private screenSenders: RTCRtpSender[] = []
  private translationTrackLangs = new Map<string, string>()
  private translationSenders: RTCRtpSender[] = []
  private langPrefs: LangPrefs | null = null
  private memberLangs = new Map<string, LangAnnouncement>()
  private translates: TranslationLevel = 'none'
  private negotiation: Promise<void> = Promise.resolve()
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
        let msg: WireMessage
        try {
          msg = JSON.parse(ev.data as string) as WireMessage
        } catch {
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
        void this.handle(msg)
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

  memberName(id: string): string {
    if (id === this.selfId) return this.opts.name
    return this.members.get(id)?.name ?? 'Guest'
  }

  async publish(stream: MediaStream): Promise<void> {
    const pc = this.newPC('up')
    this.up = pc

    this.localMic = stream.getAudioTracks()[0] ?? null
    this.localCam = stream.getVideoTracks()[0] ?? null
    this.micSender = this.localMic ? pc.addTrack(this.localMic, stream) : null
    this.camSender = this.localCam ? this.addCamera(pc, this.localCam, stream) : null

    for (const sender of pc.getSenders()) this.installSenderTransform(sender)
    await this.sendUpOffer()

    this.state = {
      mic: this.localMic?.enabled ?? false,
      cam: this.localCam?.enabled ?? false,
      sharing: false,
    }
    this.sendState()
  }

  async addScreen(stream: MediaStream): Promise<void> {
    const pc = this.up
    if (!pc) throw new Error('Publish before sharing your screen.')

    for (const track of stream.getTracks()) {
      // A share carries its own sound when the picker offered it; it is
      // announced as screen audio so the server treats it as audio and
      // every member hears what is shared.
      this.screenTrackIds.add(track.id)

      const sender = pc.addTrack(track, stream)
      this.screenSenders.push(sender)
      const transceiver = pc.getTransceivers().find((t) => t.sender === sender)
      if (transceiver) preferVP8(transceiver)
      this.installSenderTransform(sender)

      if (track.kind === 'video') {
        // 'motion' tells the browser this is a moving picture to keep up
        // with, not a scan of text to keep sharp: a shared window that
        // keeps its frame rate is what a call is missing otherwise.
        track.contentHint = 'motion'
        await tuneScreenSender(sender)
      }
    }

    this.state = { ...this.state, sharing: true }
    void this.tuneCamera()
    this.sendState()
    await this.sendUpOffer()
  }

  async removeScreen(): Promise<void> {
    const pc = this.up
    if (!pc) return

    for (const sender of this.screenSenders) {
      if (sender.track) this.screenTrackIds.delete(sender.track.id)
      try {
        pc.removeTrack(sender)
      } catch (err) {
        console.warn('removeTrack', err)
      }
    }
    this.screenSenders = []

    this.state = { ...this.state, sharing: false }
    void this.tuneCamera()
    this.sendState()
    await this.sendUpOffer()
  }

  // tuneCamera retunes the camera's encodings in place for the track it
  // sends and whether a screen is shared. A browser that refuses the
  // parameters keeps its own caps, which is a worse picture, never a
  // broken one.
  private async tuneCamera(): Promise<void> {
    const sender = this.camSender
    const track = sender?.track
    if (!sender || !track) return

    const layers = cameraLayers(track.getSettings())

    try {
      await sender.setParameters(relayerParameters(sender.getParameters(), this.state.sharing ? sharingLayers(layers) : layers))
    } catch (err) {
      console.warn('sfu: tuning the camera encoder', err)
    }
  }

  async replaceLocalTrack(kind: 'mic' | 'cam', track: MediaStreamTrack): Promise<void> {
    const pc = this.up
    if (!pc) return

    let sender = kind === 'mic' ? this.micSender : this.camSender
    if (!sender) {
      const stream = new MediaStream([track])
      sender = kind === 'mic' ? pc.addTrack(track, stream) : this.addCamera(pc, track, stream)
      this.installSenderTransform(sender)
      if (kind === 'mic') this.micSender = sender
      else this.camSender = sender
      await this.sendUpOffer()
    } else {
      await sender.replaceTrack(track)
      if (kind === 'cam') await this.tuneCamera()
    }

    if (kind === 'mic') this.localMic = track
    else this.localCam = track
  }

  /** Tells the SFU the highest camera layer this page's layout can use for a source. */
  preferLayer(sourceId: string, layer: LayerName): void {
    if (this.layoutLayers.get(sourceId) === layer) return

    this.layoutLayers.set(sourceId, layer)

    const quality = this.quality.get(sourceId) ?? newQualityState(layer)
    this.quality.set(sourceId, quality)
    this.requestLayer(sourceId, preferredLayer(layer, quality.ceiling))
  }

  private requestLayer(sourceId: string, layer: LayerName): void {
    if (this.layerPrefs.get(sourceId) === layer) return

    this.layerPrefs.set(sourceId, layer)
    this.send({ type: 'layer', member: sourceId, layer })
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
    for (const [sourceId, pc] of this.downs) {
      const counters = await readInboundCounters(pc)
      if (!counters) continue

      const previous = this.inbound.get(sourceId)
      this.inbound.set(sourceId, counters)

      const layout = this.layoutLayers.get(sourceId)
      if (!previous || !layout) continue

      const quality = this.quality.get(sourceId) ?? newQualityState(layout)
      const stepped = nextQuality(quality, layout, {
        droppedFrames: since(previous.droppedFrames, counters.droppedFrames),
        lostPackets: since(previous.lostPackets, counters.lostPackets),
      })
      this.quality.set(sourceId, stepped)

      if (stepped.ceiling !== quality.ceiling) {
        this.requestLayer(sourceId, preferredLayer(layout, stepped.ceiling))
      }
    }
  }

  setTrackEnabled(kind: 'mic' | 'cam', enabled: boolean): void {
    const track = kind === 'mic' ? this.localMic : this.localCam
    if (track) track.enabled = enabled
    this.state = kind === 'mic' ? { ...this.state, mic: enabled } : { ...this.state, cam: enabled }
    this.sendState()
  }

  get currentState(): { mic: boolean; cam: boolean; sharing: boolean } {
    return this.state
  }

  async sendChat(text: string): Promise<void> {
    const sealed = await encryptChat(this.opts.chatKey, text)
    this.send({ type: 'chat', iv: sealed.iv, ct: sealed.ct })
  }

  /** Sets and announces this member's language settings; re-sent to every joiner. */
  setLangPrefs(prefs: LangPrefs): void {
    this.langPrefs = prefs
    void this.sendLang()
  }

  setTranslates(translates: TranslationLevel): void {
    if (this.translates === translates) return
    this.translates = translates
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

  async sendCaption(caption: RoomMessage): Promise<void> {
    const sealed = await encryptChat(this.opts.chatKey, JSON.stringify(caption))
    this.send({ type: 'caption', iv: sealed.iv, ct: sealed.ct })
  }

  /** Publishes a translated-voice track, labelled translation-<lang> for the room. */
  async addTranslationTrack(lang: string, track: MediaStreamTrack): Promise<void> {
    const pc = this.up
    if (!pc) throw new Error('Publish before adding a translation track.')

    this.translationTrackLangs.set(track.id, lang)
    const sender = pc.addTrack(track, new MediaStream([track]))
    this.translationSenders.push(sender)
    this.installSenderTransform(sender)
    await this.sendUpOffer()
  }

  async removeTranslationTracks(): Promise<void> {
    const pc = this.up
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
    await this.sendUpOffer()
  }

  moderate(target: string, action: ModerateAction): void {
    this.send({ type: 'moderate', target, action })
  }

  /** Sets another member's live-translation language (host only); sealed like their own. */
  async setMemberLanguage(target: string, lang: string): Promise<void> {
    const sealed = await encryptChat(this.opts.chatKey, JSON.stringify({ lang }))
    this.send({ type: 'moderate', target, action: 'lang', iv: sealed.iv, ct: sealed.ct })
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
    this.up?.close()
    for (const pc of this.downs.values()) pc.close()
    this.downs.clear()
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
    this.up?.close()
  }

  destroy(): void {
    this.leave()
  }

  private send(msg: WireMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(msg))
  }

  private async sendLang(): Promise<void> {
    if (!this.langPrefs) return
    const sealed = await encryptChat(this.opts.chatKey, JSON.stringify({ ...this.langPrefs, translates: this.translates }))
    this.send({ type: 'lang', iv: sealed.iv, ct: sealed.ct })
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

  private addCamera(pc: RTCPeerConnection, track: MediaStreamTrack, stream: MediaStream): RTCRtpSender {
    const transceiver = pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [stream],
      sendEncodings: cameraLayers(track.getSettings()),
    })
    preferVP8(transceiver)
    return transceiver.sender
  }

  // Offers are serialized: a second createOffer/setLocalDescription
  // overlapping the first (two translation tracks added at once) makes
  // Chrome reject the description as modified.
  private sendUpOffer(): Promise<void> {
    const next = this.negotiation.then(() => this.negotiateUp())
    this.negotiation = next.catch(() => {})
    return next
  }

  private async negotiateUp(): Promise<void> {
    const pc = this.up
    if (!pc) return

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)

    const tracks = pc
      .getTransceivers()
      .filter((t) => t.sender.track && t.mid)
      .map((t) => ({ mid: t.mid as string, kind: this.kindOf(t.sender.track) }))

    this.send({ type: 'offer', sdp: pc.localDescription?.sdp ?? '', tracks })
  }

  private kindOf(track: MediaStreamTrack | null): string {
    if (!track) return 'camera'
    const translationLang = this.translationTrackLangs.get(track.id)
    if (translationLang) return `translation-${translationLang}`
    if (this.screenTrackIds.has(track.id)) return track.kind === 'audio' ? SCREEN_AUDIO_KIND : 'screen'
    if (track.kind === 'audio') return 'audio'
    return 'camera'
  }

  private async handle(msg: WireMessage): Promise<void> {
    switch (msg.type) {
      case 'answer':
        if (msg.pc === 'up' && this.up && msg.sdp) {
          await this.up.setRemoteDescription({ type: 'answer', sdp: msg.sdp })
          this.flushIce('up', this.up)
        }
        return
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
      case 'chat':
        await this.handleChat(msg)
        return
      case 'recording':
        if (msg.from) this.emit('recording', { from: msg.from, on: msg.on ?? false })
        return
      case 'lang': {
        const prefs = announcement(await this.openSealed(msg))
        if (msg.from && prefs) {
          this.memberLangs.set(msg.from, prefs)
          this.emit('lang', { from: msg.from, prefs })
        }
        return
      }
      case 'caption': {
        const caption = await this.openSealed(msg)
        // Everyone captions their own speech, and a translation names its
        // translator: anything claiming to come from another member is dropped.
        if (msg.from && isRoomMessage(caption) && (caption.k === 'translation' ? caption.by : caption.speaker) === msg.from) {
          this.emit('caption', { from: msg.from, caption })
        }
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
          const sealed = await this.openSealed(msg)
          const lang = (sealed as { lang?: unknown } | undefined)?.lang
          if (msg.from && typeof lang === 'string') this.emit('lang-set', { from: msg.from, lang })
        }
        return
      }
      case 'kicked':
        this.emit('kicked', {})
        return
      default:
        return
    }
  }

  /** Forgets a member and closes its downstream; reports whether it was known. */
  private dropMember(id: string): boolean {
    this.layerPrefs.delete(id)
    this.layoutLayers.delete(id)
    this.quality.delete(id)
    this.inbound.delete(id)
    this.memberLangs.delete(id)
    const known = this.members.delete(id)
    this.downs.get(id)?.close()
    this.downs.delete(id)
    return known
  }

  private async handleDownOffer(sourceId: string, msg: WireMessage): Promise<void> {
    let pc = this.downs.get(sourceId)
    if (!pc) {
      pc = this.newPC(`down-${sourceId}`)
      this.downs.set(sourceId, pc)
      this.startQualityWatch()
      pc.ontrack = (ev) => {
        this.installReceiverTransform(ev.receiver)
        const key = `${sourceId}:${ev.transceiver.mid ?? ''}`
        const labelled = this.downKinds.get(key)
        const kind =
          ev.track.kind === 'audio'
            ? labelled?.startsWith('translation-')
              ? labelled
              : labelled === SCREEN_AUDIO_KIND
                ? SCREEN_AUDIO_KIND
                : 'audio'
            : (labelled ?? 'camera')
        // A translated voice and a share's sound are played on their own
        // terms, never as part of the speaker's camera stream, so each
        // gets a stream of its own.
        const stream =
          kind.startsWith('translation-') || kind === SCREEN_AUDIO_KIND
            ? new MediaStream([ev.track])
            : (ev.streams[0] ?? new MediaStream([ev.track]))
        this.emit('track', { sourceId, stream, kind })
      }
    }

    for (const t of msg.tracks ?? []) this.downKinds.set(`${sourceId}:${t.mid}`, t.kind)

    await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp ?? '' })
    this.flushIce(`down-${sourceId}`, pc)

    for (const receiver of pc.getReceivers()) this.installReceiverTransform(receiver)

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    this.send({ type: 'answer', pc: `down-${sourceId}`, sdp: pc.localDescription?.sdp ?? '' })
    this.send({ type: 'pli', member: sourceId })
  }

  private handleIce(msg: WireMessage): void {
    if (!msg.candidate || !msg.pc) return

    const pc = msg.pc === 'up' ? this.up : this.downs.get(msg.pc.slice('down-'.length))
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

  private async handleChat(msg: WireMessage): Promise<void> {
    if (!msg.iv || !msg.ct) return

    try {
      const text = await decryptChat(this.opts.chatKey, { iv: msg.iv, ct: msg.ct })
      this.emit('chat', {
        id: `${msg.from ?? 'unknown'}:${msg.ts ?? 0}`,
        name: this.memberName(msg.from ?? ''),
        text,
        ts: msg.ts ?? Date.now(),
        mine: msg.from === this.selfId,
      })
    } catch (err) {
      console.warn('chat: undecryptable message', err)
    }
  }

  /** Decrypts a sealed JSON message; undefined when it cannot be opened. */
  private async openSealed(msg: WireMessage): Promise<unknown> {
    if (!msg.iv || !msg.ct) return undefined
    try {
      return JSON.parse(await decryptChat(this.opts.chatKey, { iv: msg.iv, ct: msg.ct })) as unknown
    } catch (err) {
      console.warn('undecryptable message:', msg.type, err)
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
    if (this.up) connections.push(['up', this.up])
    for (const [id, down] of this.downs) connections.push([`down-${id.slice(0, 6)}`, down])

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
      } catch {
        lines.push(`${label} stats unavailable`)
      }
    }

    return lines.join('\n')
  }
}
