// The maths behind speaking detection, kept apart from the audio graph so
// it can be reasoned about on its own.

/**
 * How often every probe is measured, in milliseconds: often enough that
 * the ring lights on a voice's first sound rather than up to a quarter of
 * a second after it.
 */
export const SPEAKING_SAMPLE_MS = 100

/** Samples per stretch of sound judged on its own, about 21 ms at 48 kHz. */
const BLOCK = 1024

/** RMS below which a frame counts as silence, from 0 to 1. */
const SILENT_RMS = 0.04

/**
 * How long someone still counts as speaking after the last voiced
 * moment, in milliseconds: long enough to bridge the pause between words,
 * short enough that a single click does not leave them speaking.
 */
export const SPEAKING_HOLD_MS = 700

/**
 * isVoiced is whether a frame of samples, each from -1 to 1, carries
 * sound anywhere: in any stretch of BLOCK samples, so a syllable between
 * quiet ones is heard rather than averaged away.
 */
export function isVoiced(frame: Float32Array): boolean {
  for (let start = 0; start < frame.length; start += BLOCK) {
    const end = Math.min(start + BLOCK, frame.length)
    let sum = 0
    for (let i = start; i < end; i++) sum += frame[i] * frame[i]
    if (Math.sqrt(sum / (end - start)) > SILENT_RMS) return true
  }

  return false
}

/** When a voice was last heard, in milliseconds, or null if it never was. */
export type LastVoiced = number | null

/** heard is lastVoiced after observing whether a voice is on at now. */
export function heard(lastVoiced: LastVoiced, voiced: boolean, now: number): LastVoiced {
  return voiced ? now : lastVoiced
}

/**
 * holdLeft is how many milliseconds someone still counts as speaking from
 * now, where lastVoiced is when a voice was last heard; 0 means they are
 * not. Every speaking signal goes through this one rule, so a voice heard
 * directly, one heard through its translation and the recording's
 * spotlight all behave the same.
 */
export function holdLeft(lastVoiced: LastVoiced, now: number): number {
  if (lastVoiced === null) return 0

  return Math.max(0, lastVoiced + SPEAKING_HOLD_MS - now)
}
