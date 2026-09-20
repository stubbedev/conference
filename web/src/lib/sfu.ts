// RoomClient: the browser side of the signaling protocol (see
// internal/sfu) and the WebRTC engine. Each member publishes one
// upstream peer connection and answers one downstream connection per
// remote source. When the room is end-to-end encrypted, encoded frames
// are transformed through the E2EE worker, so the server only ever
// relays ciphertext.

import { decryptChat, encryptChat } from '@/lib/roomkeys'

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
export type ForcedAction = Exclude<ModerateAction, 'kick'>

export interface RoomClientOptions {
  slug: string
  session: string
  name: string
  mediaKey: Uint8Array<ArrayBuffer>
  chatKey: CryptoKey
  iceServers: RTCIceServer[]
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
}

interface Events {
  welcome: { self: MemberInfo; members: MemberInfo[] }
  'member-joined': MemberInfo
  'member-left': { id: string }
  'member-state': { id: string; mic: boolean; cam: boolean; sharing: boolean }
  track: RemoteTrack
  'track-removed': { sourceId: string; mid: string }
  chat: ChatMessage
  error: { code: string; text: string }
  forced: { action: ForcedAction }
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
  private transformed = new WeakSet<object>()
  private selfId = ''
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
      const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
      const ws = new WebSocket(`${scheme}://${location.host}/ws`)
      this.ws = ws

      const timeout = setTimeout(() => reject(new Error('Join timed out.')), 15_000)

      ws.onopen = () => {
        this.send({ type: 'join', room: this.opts.slug, session: this.opts.session, name: this.opts.name })
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
          if (msg.self) this.selfId = msg.self.id
          for (const member of msg.members ?? []) this.members.set(member.id, member)
          this.emit('welcome', { self: msg.self as MemberInfo, members: msg.members ?? [] })
          resolve()
          return
        }
        if (msg.type === 'error') {
          clearTimeout(timeout)
          reject(new Error(msg.text ?? 'The room rejected the join.'))
          this.emit('error', { code: msg.code ?? '', text: msg.text ?? '' })
          return
        }
        void this.handle(msg)
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error('Signaling connection failed.'))
      }
      ws.onclose = () => {
        this.emit('closed', {})
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

  memberName(id: string): string {
    if (id === this.selfId) return this.opts.name
    return this.members.get(id)?.name ?? 'Guest'
  }

  async publish(stream: MediaStream): Promise<void> {
    const pc = this.newPC('up')
    this.up = pc

    for (const track of stream.getTracks()) pc.addTrack(track, stream)
    this.localMic = stream.getAudioTracks()[0] ?? null
    this.localCam = stream.getVideoTracks()[0] ?? null

    for (const transceiver of pc.getTransceivers()) preferVP8(transceiver)
    for (const sender of pc.getSenders()) this.installSenderTransform(sender)
    this.micSender = pc.getSenders().find((sender) => sender.track?.kind === 'audio') ?? null
    this.camSender = pc.getSenders().find((sender) => sender.track?.kind === 'video') ?? null
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

    for (const track of stream.getVideoTracks()) {
      this.screenTrackIds.add(track.id)
      const sender = pc.addTrack(track, stream)
      this.screenSenders.push(sender)
      const transceiver = pc.getTransceivers().find((t) => t.sender === sender)
      if (transceiver) preferVP8(transceiver)
      this.installSenderTransform(sender)
    }

    this.state = { ...this.state, sharing: true }
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
    this.sendState()
    await this.sendUpOffer()
  }

  async replaceLocalTrack(kind: 'mic' | 'cam', track: MediaStreamTrack): Promise<void> {
    const pc = this.up
    if (!pc) return

    let sender = kind === 'mic' ? this.micSender : this.camSender
    if (!sender) {
      sender = pc.addTrack(track, new MediaStream([track]))
      this.installSenderTransform(sender)
      if (kind === 'mic') this.micSender = sender
      else this.camSender = sender
      await this.sendUpOffer()
    } else {
      await sender.replaceTrack(track)
    }

    if (kind === 'mic') this.localMic = track
    else this.localCam = track
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

  moderate(target: string, action: ModerateAction): void {
    this.send({ type: 'moderate', target, action })
  }

  leave(): void {
    this.ws?.close()
    this.up?.close()
    for (const pc of this.downs.values()) pc.close()
    this.downs.clear()
    this.worker.terminate()
  }

  private send(msg: WireMessage): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(msg))
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
    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers })
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

  private async sendUpOffer(): Promise<void> {
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
    if (track.kind === 'audio') return 'audio'
    if (this.screenTrackIds.has(track.id)) return 'screen'
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
          this.members.set(member.id, member)
          this.emit('member-joined', member)
        }
        return
      }
      case 'member-left':
        if (msg.id) {
          this.members.delete(msg.id)
          this.downs.get(msg.id)?.close()
          this.downs.delete(msg.id)
          this.emit('member-left', { id: msg.id })
        }
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
      case 'forced': {
        const action = msg.action
        if (action === 'mute' || action === 'cam' || action === 'screen') {
          this.emit('forced', { action })
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

  private async handleDownOffer(sourceId: string, msg: WireMessage): Promise<void> {
    let pc = this.downs.get(sourceId)
    if (!pc) {
      pc = this.newPC(`down-${sourceId}`)
      this.downs.set(sourceId, pc)
      pc.ontrack = (ev) => {
        this.installReceiverTransform(ev.receiver)
        const key = `${sourceId}:${ev.transceiver.mid ?? ''}`
        const kind = ev.track.kind === 'audio' ? 'audio' : (this.downKinds.get(key) ?? 'camera')
        const stream = ev.streams[0] ?? new MediaStream([ev.track])
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
