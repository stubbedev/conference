// End-to-end media frame encryption worker.
//
// Frame layout: [1 clear byte (RTP payload descriptor)][16-byte AES-CTR
// counter block][ciphertext]. The clear byte keeps RTP payload
// descriptors readable along the path; the remainder is encrypted.
//
// The counter block is carried in the frame itself (SFrame-style
// explicit IV): a random salt per transform plus a monotonically
// increasing counter. Deriving it from frame.timestamp instead breaks
// on the receive side, where timestamps are resampled by A/V sync and
// jitter processing shortly after join (and may be fractional, which
// throws in BigInt) — sender and receiver then derive different
// keystreams and every frame, keyframes included, fails to decrypt,
// freezing the picture permanently. The key never leaves this worker.
//
// The worker also counts frames processed and dropped per direction and
// reports the last error, so the page can show exactly whether the
// transform is the stage dropping frames on a given device.

const UNPROTECTED = 1
const BLOCK_BYTES = 16
const SALT_BYTES = 8

let cryptoKeyPromise = null

const stats = { send: 0, recv: 0, dropSend: 0, dropRecv: 0, lastError: '' }

setInterval(() => {
  postMessage({ type: 'e2ee-stats', ...stats })
}, 2000)

function setKeyBytes(bytes) {
  cryptoKeyPromise = crypto.subtle.importKey('raw', bytes, 'AES-CTR', false, ['encrypt', 'decrypt'])
}

// encryptFrame seals one frame under the transform's salt and counter;
// the counter then advances past every block this frame consumed, so
// keystream blocks are never reused across frames.
async function encryptFrame(frame, state) {
  const data = new Uint8Array(frame.data)
  const counterBlock = new Uint8Array(BLOCK_BYTES)
  counterBlock.set(state.salt, 0)
  new DataView(counterBlock.buffer).setBigUint64(SALT_BYTES, state.counter)

  const key = await cryptoKeyPromise
  const out = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: counterBlock, length: 64 },
    key,
    data.subarray(UNPROTECTED),
  )

  const merged = new Uint8Array(UNPROTECTED + BLOCK_BYTES + out.byteLength)
  merged.set(data.subarray(0, UNPROTECTED), 0)
  merged.set(counterBlock, UNPROTECTED)
  merged.set(new Uint8Array(out), UNPROTECTED + BLOCK_BYTES)

  state.counter += BigInt(Math.ceil(out.byteLength / BLOCK_BYTES) || 1)

  return merged
}

// decryptFrame reads the counter block straight off the wire, so the
// receiver never depends on local frame timing.
async function decryptFrame(frame) {
  const data = new Uint8Array(frame.data)
  if (data.length <= UNPROTECTED + BLOCK_BYTES) return data

  const key = await cryptoKeyPromise
  const out = await crypto.subtle.decrypt(
    {
      name: 'AES-CTR',
      counter: data.subarray(UNPROTECTED, UNPROTECTED + BLOCK_BYTES),
      length: 64,
    },
    key,
    data.subarray(UNPROTECTED + BLOCK_BYTES),
  )

  const merged = new Uint8Array(UNPROTECTED + out.byteLength)
  merged.set(data.subarray(0, UNPROTECTED), 0)
  merged.set(new Uint8Array(out), UNPROTECTED)

  return merged
}

function pipe(transformer, encrypt) {
  const state = {
    salt: crypto.getRandomValues(new Uint8Array(SALT_BYTES)),
    counter: 0n,
  }

  const transform = new TransformStream({
    async transform(frame, controller) {
      try {
        const data = encrypt ? await encryptFrame(frame, state) : await decryptFrame(frame)
        frame.setData(data.buffer)
        controller.enqueue(frame)
        if (encrypt) stats.send += 1
        else stats.recv += 1
      } catch (err) {
        // A frame we cannot process is dropped rather than forwarded
        // in the clear.
        stats.lastError = String(err)
        if (encrypt) stats.dropSend += 1
        else stats.dropRecv += 1
      }
    },
  })
  transformer.readable.pipeThrough(transform).pipeTo(transformer.writable).catch(() => {})
}

self.onrtctransform = (event) => {
  const transformer = event.transformer
  pipe(transformer, transformer.options?.purpose === 'send')
}

self.onmessage = (event) => {
  const msg = event.data
  if (msg.keyBytes) {
    setKeyBytes(msg.keyBytes)
    return
  }
  if (msg.streams) {
    const { readable, writable } = msg.streams
    pipe({ readable, writable, options: { purpose: msg.purpose } }, msg.purpose === 'send')
  }
}
