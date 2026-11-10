// End-to-end media frame encryption worker.
//
// Runs as an RTCRtpScriptTransform on every sender and receiver. Frame
// layout on the wire:
//
//   [clear prefix][16-byte AES-CTR counter block][ciphertext]
//
// The clear prefix is the part of the codec bitstream that the RTP
// layer and hardware decoders read *before* the receiving transform
// runs: for VP8 the 10-byte keyframe header (frame tag, start code,
// width and height) or the 3-byte frame tag of a delta frame; for
// audio the 1-byte Opus TOC. Encrypting those bytes makes the
// depacketizer parse random dimensions and frame types — software
// decoders shrug, hardware decoders on phones stall after the first
// frame. This is the same split Jitsi and the WebRTC insertable-streams
// sample use.
//
// The counter block is carried in the frame (SFrame-style explicit IV):
// a random per-transform salt plus a counter advanced past every block
// consumed, so keystream blocks are never reused and the receiver never
// depends on local frame timing. The key never leaves this worker.
//
// This file is compiled against the WebWorker typings (see
// tsconfig.worker.json), so a call that does not exist on
// RTCEncodedVideoFrame is a build error, not a silently dropped frame.

import { isTransformOptions, type E2EEStats, type TransformCounts, type TransformOptions, type WorkerMessage } from './e2ee'

const BLOCK_BYTES = 16
const SALT_BYTES = 8

const CLEAR_PREFIX: Record<EncodedVideoChunkType | 'audio', number> = {
  key: 10,
  delta: 3,
  audio: 1,
}

type EncodedFrame = RTCEncodedVideoFrame | RTCEncodedAudioFrame

interface SendState {
  salt: Uint8Array<ArrayBuffer>
  counter: bigint
}

let cryptoKeyPromise: Promise<CryptoKey> | null = null

const stats: Omit<E2EEStats, 'transforms'> = { type: 'e2ee-stats', send: 0, recv: 0, dropSend: 0, dropRecv: 0, lastError: '' }

/** One transform being piped: its transformer, its counters, and the way to end its pipe. */
interface Piped {
  transformer: RTCRtpScriptTransformer
  counts: TransformCounts
  closing: AbortController
}

// The transforms being piped right now, by id. One leaves when its pipe
// ends, which the page brings about when it closes the connection, so a
// long call's report stays as long as what it is sending and receiving.
//
// Each holds on to its transformer for as long as it is piped. Chrome
// connects a transformer to its sender or receiver in a task of its own,
// after the rtctransform event, and reaches it through a weak reference:
// a transformer the script has let go of can be collected in between, and
// then no frame ever arrives on its streams, with nothing reported.
const piping = new Map<number, Piped>()

// A transform whose connection closed before its rtctransform event
// arrived: the two travel on different queues. It is never piped.
const closedUnopened = new Set<number>()

setInterval(() => {
  const report: E2EEStats = { ...stats, transforms: [...piping.values()].map((piped) => piped.counts) }
  postMessage(report)
}, 2000)

function setKeyBytes(bytes: Uint8Array<ArrayBuffer>): void {
  cryptoKeyPromise = crypto.subtle.importKey('raw', bytes, 'AES-CTR', false, ['encrypt', 'decrypt'])
}

function closeTransform(id: number): void {
  const piped = piping.get(id)
  if (piped) piped.closing.abort()
  else closedUnopened.add(id)
}

function isVideoFrame(frame: EncodedFrame): frame is RTCEncodedVideoFrame {
  return 'type' in frame
}

// clearPrefix returns how many leading bytes of this frame stay
// readable. A frame shorter than its nominal header is left entirely
// in the clear: there is nothing meaningful to hide in it.
function clearPrefix(frame: EncodedFrame, length: number): number {
  const nominal = isVideoFrame(frame) ? CLEAR_PREFIX[frame.type] : CLEAR_PREFIX.audio
  return Math.min(nominal, length)
}

async function requireKey(): Promise<CryptoKey> {
  if (!cryptoKeyPromise) throw new Error('e2ee: media key not set')
  return cryptoKeyPromise
}

// encryptFrame seals one frame under the transform's salt and counter;
// the counter then advances past every block this frame consumed.
async function encryptFrame(frame: EncodedFrame, state: SendState): Promise<ArrayBuffer> {
  const data = new Uint8Array(frame.data)
  const prefix = clearPrefix(frame, data.length)

  const counterBlock = new Uint8Array(BLOCK_BYTES)
  counterBlock.set(state.salt, 0)
  new DataView(counterBlock.buffer).setBigUint64(SALT_BYTES, state.counter)

  const key = await requireKey()
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: counterBlock, length: 64 },
    key,
    data.subarray(prefix),
  )

  const merged = new Uint8Array(prefix + BLOCK_BYTES + sealed.byteLength)
  merged.set(data.subarray(0, prefix), 0)
  merged.set(counterBlock, prefix)
  merged.set(new Uint8Array(sealed), prefix + BLOCK_BYTES)

  state.counter += BigInt(Math.ceil(sealed.byteLength / BLOCK_BYTES) || 1)

  return merged.buffer
}

// decryptFrame reads the counter block straight off the wire.
async function decryptFrame(frame: EncodedFrame): Promise<ArrayBuffer> {
  const data = new Uint8Array(frame.data)
  const prefix = clearPrefix(frame, data.length)
  if (data.length < prefix + BLOCK_BYTES) throw new Error('e2ee: frame too short')

  const key = await requireKey()
  const opened = await crypto.subtle.decrypt(
    {
      name: 'AES-CTR',
      counter: data.subarray(prefix, prefix + BLOCK_BYTES),
      length: 64,
    },
    key,
    data.subarray(prefix + BLOCK_BYTES),
  )

  const merged = new Uint8Array(prefix + opened.byteLength)
  merged.set(data.subarray(0, prefix), 0)
  merged.set(new Uint8Array(opened), prefix)

  return merged.buffer
}

function pipe(transformer: RTCRtpScriptTransformer, options: TransformOptions): void {
  const encrypt = options.purpose === 'send'
  const state: SendState = {
    salt: crypto.getRandomValues(new Uint8Array(SALT_BYTES)),
    counter: 0n,
  }
  const counts: TransformCounts = { ...options, openedAt: Date.now(), read: 0, written: 0, dropped: 0 }
  const closing = new AbortController()
  piping.set(options.id, { transformer, counts, closing })

  const transform = new TransformStream<EncodedFrame, EncodedFrame>({
    async transform(frame, controller) {
      counts.read += 1
      try {
        frame.data = encrypt ? await encryptFrame(frame, state) : await decryptFrame(frame)
        controller.enqueue(frame)
        counts.written += 1
        if (encrypt) stats.send += 1
        else stats.recv += 1
      } catch (err) {
        // A frame we cannot process is dropped rather than forwarded
        // in the clear; the page reads lastError from the stats.
        stats.lastError = String(err)
        counts.dropped += 1
        if (encrypt) stats.dropSend += 1
        else stats.dropRecv += 1
      }
    },
  })

  transformer.readable
    .pipeThrough(transform, { signal: closing.signal })
    .pipeTo(transformer.writable, { signal: closing.signal })
    .catch((err: unknown) => {
      if (!closing.signal.aborted) console.warn(`e2ee: the pipe of ${options.purpose} frames ended`, err)
    })
    .finally(() => piping.delete(options.id))
}

self.onrtctransform = (event: RTCTransformEvent) => {
  const options: unknown = event.transformer.options
  if (!isTransformOptions(options)) throw new Error(`e2ee: a transform attached with options the worker cannot read: ${JSON.stringify(options)}`)
  if (piping.has(options.id)) throw new Error(`e2ee: two transforms attached as number ${options.id}`)
  if (closedUnopened.delete(options.id)) return
  pipe(event.transformer, options)
}

self.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data
  if (message.type === 'key') setKeyBytes(message.keyBytes)
  else message.ids.forEach(closeTransform)
}
