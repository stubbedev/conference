// A voice detection that reads loudness instead of listening: the
// stand-in for the Silero model where there is no model, such as the
// stand-in engines the browser tests run on. The levels are the mic
// gate's own: below the level a muted mic sits at is no speech.

import { GATE_CLOSE_DBFS, GATE_OPEN_DBFS } from '../noise-gate.ts'

const SILENCE_FLOOR = 1e-7

function dbfs(frame: Int16Array): number {
  let sum = 0
  for (const sample of frame) sum += (sample / 0x8000) ** 2
  const mean = sum / frame.length
  return 10 * Math.log10(Math.max(mean, SILENCE_FLOOR))
}

/** How likely frame is speech, from 0 to 1, by how loud it is. */
export function loudness(frame: Int16Array): number {
  const level = dbfs(frame)
  if (level >= GATE_OPEN_DBFS) return 1
  if (level <= GATE_CLOSE_DBFS) return 0
  return (level - GATE_CLOSE_DBFS) / (GATE_OPEN_DBFS - GATE_CLOSE_DBFS)
}
