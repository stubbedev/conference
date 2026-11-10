// The maths behind speaking detection, kept apart from the audio graph so
// it can be reasoned about on its own.

/** How often every probe is measured, in milliseconds. */
export const SPEAKING_SAMPLE_MS = 250

/** RMS below which a frame counts as silence, from 0 to 1. */
const SILENT_RMS = 0.04

/**
 * How long someone still counts as speaking after the last voiced
 * moment, in milliseconds: long enough to bridge the pause between words,
 * short enough that a single click does not leave them speaking.
 */
export const SPEAKING_HOLD_MS = 700

/** isVoiced is whether a frame of this root-mean-square amplitude carries sound. */
export function isVoiced(rms: number): boolean {
  return rms > SILENT_RMS
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
