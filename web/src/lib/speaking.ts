// The maths behind speaking detection, kept apart from the audio graph so
// it can be reasoned about on its own.

/** How often every probe is measured, in milliseconds. */
export const SPEAKING_SAMPLE_MS = 250

/** RMS below which a frame counts as silence, from 0 to 1. */
const SILENT_RMS = 0.04

/** How fast the level rises towards a loud frame and falls away after one. */
const ATTACK = 0.7
const DECAY = 0.5

/** The smoothed level an indicator needs to show someone as speaking. */
const SPEAKING_LEVEL = 0.35

/**
 * nextLevel is the smoothed loudness of one more frame, where rms is that
 * frame's root-mean-square amplitude. The rise is fast and the fall slow,
 * so a voice does not flicker the ring between syllables.
 */
export function nextLevel(level: number, rms: number): number {
  const target = rms > SILENT_RMS ? 1 : 0

  return target > level ? level + (1 - level) * ATTACK : level * DECAY
}

export function isSpeaking(level: number): boolean {
  return level > SPEAKING_LEVEL
}
