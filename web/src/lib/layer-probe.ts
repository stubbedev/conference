import { codecPreferences, screenLayers, type VideoCodec } from './encodings.ts'

// Whether this browser really sends a shared screen's two encodings in a
// codec. Safari 26 says through mediaCapabilities that it encodes VP9
// simulcast and accepts both encodings, yet only ever produces the slow
// one, so every viewer gets the share at 5 fps. Asking the browser does
// not tell; watching it encode does. The probe sends a small canvas
// between two connections inside the page, nothing leaves the device.

const PROBE_WIDTH = 640
const PROBE_HEIGHT = 360
const PROBE_FPS = 30
const POLL_MS = 50
const PROBE_TIMEOUT_MS = 1500

/**
 * How long after the first encoded frame every encoding must have
 * encoded one. Chrome starts both within about 100 ms of each other,
 * Safari's VP8 within about 50 ms; Safari's VP9 never starts the second.
 */
export const LAYER_GRACE_MS = 500

/**
 * probeVerdict reads one sample of the rids that have encoded a frame:
 * true once every encoding has, false once one still has not a grace
 * period after the first frame, undefined while it cannot yet tell.
 */
export function probeVerdict(encoded: ReadonlySet<string>, rids: readonly string[], sinceFirstFrameMs: number): boolean | undefined {
  if (rids.every((rid) => encoded.has(rid))) return true
  if (encoded.size > 0 && sinceFirstFrameMs >= LAYER_GRACE_MS) return false
  return undefined
}

/**
 * simulcastAnswer makes the receiving side's answer accept every rid as
 * its own stream, the way the SFU answers a share: a browser answering
 * its own offer leaves the simulcast lines out.
 */
export function simulcastAnswer(sdp: string, rids: readonly string[]): string {
  const lines = sdp.split('\r\n')
  if (lines.some((line) => line.startsWith('a=simulcast:'))) return sdp
  const at = lines.findIndex((line) => line.startsWith('a=mid:')) + 1
  if (at === 0) return sdp
  const added = [...rids.map((rid) => `a=rid:${rid} recv`), `a=simulcast:recv ${rids.join(';')}`]
  return [...lines.slice(0, at), ...added, ...lines.slice(at)].join('\r\n')
}

function encodedRids(report: RTCStatsReport): Set<string> {
  const encoded = new Set<string>()
  report.forEach((stat: { type?: string; kind?: string; rid?: string; framesEncoded?: number }) => {
    if (stat.type === 'outbound-rtp' && stat.kind === 'video' && stat.rid && (stat.framesEncoded ?? 0) > 0) encoded.add(stat.rid)
  })
  return encoded
}

function paintedTrack(): { track: MediaStreamTrack; stop: () => void } {
  const canvas = Object.assign(document.createElement('canvas'), { width: PROBE_WIDTH, height: PROBE_HEIGHT })
  const context = canvas.getContext('2d')
  let frame = 0
  const paint = () => {
    if (!context) return
    context.fillStyle = frame++ % 2 === 0 ? '#000' : '#fff'
    context.fillRect(0, 0, PROBE_WIDTH, PROBE_HEIGHT)
  }
  paint()
  const timer = setInterval(paint, 1000 / PROBE_FPS)
  const [track] = canvas.captureStream(PROBE_FPS).getVideoTracks()
  return {
    track,
    stop: () => {
      clearInterval(timer)
      track.stop()
    },
  }
}

/**
 * sendsBothLayers encodes a painted canvas in the share's two encodings
 * and the given codec between two local connections, and reports whether
 * both produced frames. Anything that goes wrong counts as no.
 */
export async function sendsBothLayers(codec: VideoCodec): Promise<boolean> {
  const layers = screenLayers(codec)
  const rids = layers.flatMap((layer) => (layer.rid ? [layer.rid] : []))
  const { track, stop } = paintedTrack()
  const sender = new RTCPeerConnection()
  const receiver = new RTCPeerConnection()
  try {
    sender.onicecandidate = (event) => void (event.candidate && receiver.addIceCandidate(event.candidate).catch(() => {}))
    receiver.onicecandidate = (event) => void (event.candidate && sender.addIceCandidate(event.candidate).catch(() => {}))
    const transceiver = sender.addTransceiver(track, { direction: 'sendonly', sendEncodings: layers })
    // Without the VP8 fallback the share has: the probe must encode the codec it tests.
    const preferred = codecPreferences(RTCRtpSender.getCapabilities('video')?.codecs ?? [], codec).filter(
      (capability) => codec === 'VP8' || capability.mimeType !== 'video/VP8',
    )
    if (preferred.length === 0) return false
    transceiver.setCodecPreferences(preferred)

    const offer = await sender.createOffer()
    await sender.setLocalDescription(offer)
    await receiver.setRemoteDescription(offer)
    const answer = await receiver.createAnswer()
    await receiver.setLocalDescription(answer)
    await sender.setRemoteDescription({ type: 'answer', sdp: simulcastAnswer(answer.sdp ?? '', rids) })

    const deadline = performance.now() + PROBE_TIMEOUT_MS
    let firstFrameAt: number | null = null
    while (performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      const encoded = encodedRids(await sender.getStats())
      const now = performance.now()
      if (encoded.size > 0) firstFrameAt ??= now
      const verdict = probeVerdict(encoded, rids, firstFrameAt === null ? 0 : now - firstFrameAt)
      if (verdict !== undefined) return verdict
    }
    return false
  } catch (err) {
    console.warn('layer probe: encoding the share layers locally', err)
    return false
  } finally {
    stop()
    sender.close()
    receiver.close()
  }
}
