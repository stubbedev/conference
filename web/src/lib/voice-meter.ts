import { heard, holdLeft, isVoiced, type LastVoiced } from './speaking.ts'

/**
 * Samples each measurement reads: all the sound since the one before
 * (SPEAKING_SAMPLE_MS is 4,800 samples at 48 kHz), so a syllable spoken
 * between two measurements still counts.
 */
export const METER_SAMPLES = 8192

/**
 * VoiceMeter tells whether the audio fed into its input carries a voice,
 * under the one speaking rule every indicator shares. Connect a source
 * to input, call sample on each speaking tick, and ask speaking.
 */
export class VoiceMeter {
  readonly input: AnalyserNode
  private readonly frame: Float32Array<ArrayBuffer>
  private lastVoiced: LastVoiced = null

  constructor(ctx: BaseAudioContext) {
    this.input = ctx.createAnalyser()
    this.input.fftSize = METER_SAMPLES
    this.frame = new Float32Array(METER_SAMPLES)
  }

  sample(now: number): void {
    this.input.getFloatTimeDomainData(this.frame)
    this.lastVoiced = heard(this.lastVoiced, isVoiced(this.frame), now)
  }

  speaking(now: number): boolean {
    return holdLeft(this.lastVoiced, now) > 0
  }
}
