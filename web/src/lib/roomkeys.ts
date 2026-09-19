// Room key handling on the client: base64url codecs, the PBKDF2 proof
// (parameters must match the server's roomcrypt package), keyblob
// decryption, and the HKDF subkeys for media frames and chat.

const PBKDF2_ITERATIONS = 210_000
const HKDF_SALT = 'conference-e2ee'
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

// Bytes backed by a plain ArrayBuffer, as WebCrypto's BufferSource
// expects under the TS 5.7+ typed-array generics.
type Bytes = Uint8Array<ArrayBuffer>

export function toB64(bytes: Bytes): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export function fromB64(text: string): Bytes {
  const normalized = text.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i)
  }
  return out
}

export function randomRoomKey(): Bytes {
  return crypto.getRandomValues(new Uint8Array(32))
}

// deriveProof computes the password proof the server compares.
export async function deriveProof(password: string, authSaltB64: string): Promise<string> {
  const material = await crypto.subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, [
    'deriveBits',
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(authSaltB64), iterations: PBKDF2_ITERATIONS },
    material,
    256,
  )
  return toB64(new Uint8Array(bits))
}

// openKeyblob decrypts the sealed room key with the password. The nonce
// is the first 12 bytes of the blob, matching the server's SealKeyblob.
export async function openKeyblob(keyblobB64: string, keySaltB64: string, password: string): Promise<Bytes> {
  const material = await crypto.subtle.importKey('raw', textEncoder.encode(password), 'PBKDF2', false, [
    'deriveKey',
  ])
  const kek = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: fromB64(keySaltB64), iterations: PBKDF2_ITERATIONS },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  )
  const blob = fromB64(keyblobB64)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12) }, kek, blob.slice(12))
  return new Uint8Array(plain)
}

async function hkdfBits(raw: Bytes, info: string): Promise<Bytes> {
  const key = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: textEncoder.encode(HKDF_SALT),
      info: textEncoder.encode(info),
    },
    key,
    256,
  )
  return new Uint8Array(bits)
}

// deriveMediaKeyMaterial derives the raw AES-CTR key used by the E2EE
// frame worker.
export async function deriveMediaKeyMaterial(raw: Bytes): Promise<Bytes> {
  return hkdfBits(raw, 'media-frame')
}

// deriveChatKey derives the AES-GCM key for encrypted chat messages.
export async function deriveChatKey(raw: Bytes): Promise<CryptoKey> {
  const bits = await hkdfBits(raw, 'chat')
  return crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export interface SealedChat {
  iv: string
  ct: string
}

export async function encryptChat(key: CryptoKey, text: string): Promise<SealedChat> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, textEncoder.encode(text))
  return { iv: toB64(iv), ct: toB64(new Uint8Array(ct)) }
}

export async function decryptChat(key: CryptoKey, sealed: SealedChat): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(sealed.iv) },
    key,
    fromB64(sealed.ct),
  )
  return textDecoder.decode(plain)
}
