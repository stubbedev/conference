import { heard, holdLeft, isVoiced, type LastVoiced } from './speaking.ts'

const FFT_SIZE = 1024

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
    this.input.fftSize = FFT_SIZE
    this.frame = new Float32Array(FFT_SIZE)
  }

  sample(now: number): void {
    this.input.getFloatTimeDomainData(this.frame)
    this.lastVoiced = heard(this.lastVoiced, isVoiced(this.frame), now)
  }

  speaking(now: number): boolean {
    return holdLeft(this.lastVoiced, now) > 0
  }
}
