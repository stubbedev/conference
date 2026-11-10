// The browsers capture and cut speech as 16-bit PCM; every model in the
// speech pipeline takes float samples between -1 and 1 instead. One
// conversion, so the same arithmetic is not written out once per engine.

/** The one sample value that has no positive counterpart: -2^15. */
const FULL_SCALE = 0x8000

/** pcm as floats between -1 and 1, at the same rate and length. */
export function toFloat32(pcm: Int16Array): Float32Array {
  const audio = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) audio[i] = pcm[i] / FULL_SCALE
  return audio
}

/**
 * frame preceded by the samples a model reads it in: a voice detection
 * model judges a frame together with the tail of the one before it.
 */
export function withContext(context: Float32Array, frame: Float32Array): Float32Array {
  const input = new Float32Array(context.length + frame.length)
  input.set(context)
  input.set(frame, context.length)
  return input
}
