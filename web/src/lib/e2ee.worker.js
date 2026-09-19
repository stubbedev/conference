// End-to-end media frame encryption worker.
//
// The first byte of every encoded frame stays in the clear (RTP payload
// descriptors must stay readable along the path); the remainder is
// AES-CTR encrypted. The counter block carries the frame timestamp, so
// sender and receiver derive the same keystream without extra
// signaling. The key never leaves this worker.

let cryptoKeyPromise = null

const UNPROTECTED = 1

function setKeyBytes(bytes) {
  cryptoKeyPromise = crypto.subtle.importKey('raw', bytes, 'AES-CTR', false, ['encrypt', 'decrypt'])
}

function counterFor(timestamp) {
  const iv = new Uint8Array(16)
  new DataView(iv.buffer).setBigUint64(8, BigInt(timestamp))
  return iv
}

async function transformFrame(frame, encrypt) {
  const data = new Uint8Array(frame.data)
  const head = data.subarray(0, UNPROTECTED)
  const body = data.subarray(UNPROTECTED)
  const key = await cryptoKeyPromise
  const out = await crypto.subtle[encrypt ? 'encrypt' : 'decrypt'](
    { name: 'AES-CTR', counter: counterFor(frame.timestamp), length: 64 },
    key,
    body,
  )
  const merged = new Uint8Array(UNPROTECTED + out.byteLength)
  merged.set(head)
  merged.set(new Uint8Array(out), UNPROTECTED)
  return merged
}

function pipe(transformer, encrypt) {
  const transform = new TransformStream({
    async transform(frame, controller) {
      try {
        const data = await transformFrame(frame, encrypt)
        frame.setData(data.buffer)
        controller.enqueue(frame)
      } catch (err) {
        // A frame we cannot process is dropped rather than forwarded
        // in the clear.
        console.warn('e2ee: dropping frame', err)
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
