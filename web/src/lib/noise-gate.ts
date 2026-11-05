export const GATE_OPEN_DBFS = -45
export const GATE_CLOSE_DBFS = -52
export const GATE_HOLD_SECONDS = 0.2
export const GATE_ATTACK_SECONDS = 0.005
export const GATE_RELEASE_SECONDS = 0.15
const ENVELOPE_DECAY_SECONDS = 0.05

const amplitude = (dbfs: number): number => 10 ** (dbfs / 20)
const smoothing = (seconds: number, sampleRate: number): number => Math.exp(-1 / (seconds * sampleRate))

export class NoiseGate {
  private readonly openLevel = amplitude(GATE_OPEN_DBFS)
  private readonly closeLevel = amplitude(GATE_CLOSE_DBFS)
  private readonly holdSamples: number
  private readonly envelopeDecay: number
  private readonly attack: number
  private readonly release: number
  private envelope = 0
  private gain = 0
  private open = false
  private holdRemaining = 0

  constructor(sampleRate: number) {
    if (!(sampleRate > 0)) throw new RangeError(`NoiseGate needs a positive sample rate, got ${sampleRate}`)
    this.holdSamples = Math.round(GATE_HOLD_SECONDS * sampleRate)
    this.envelopeDecay = smoothing(ENVELOPE_DECAY_SECONDS, sampleRate)
    this.attack = smoothing(GATE_ATTACK_SECONDS, sampleRate)
    this.release = smoothing(GATE_RELEASE_SECONDS, sampleRate)
  }

  process(input: readonly Float32Array[], output: readonly Float32Array[]): void {
    const frames = output[0]?.length ?? 0
    const channels = Math.min(input.length, output.length)
    for (let frame = 0; frame < frames; frame++) {
      let peak = 0
      for (let channel = 0; channel < channels; channel++) {
        peak = Math.max(peak, Math.abs(input[channel][frame]))
      }
      this.envelope = Math.max(peak, this.envelope * this.envelopeDecay)
      this.advance()
      const target = this.open ? 1 : 0
      const coefficient = target > this.gain ? this.attack : this.release
      this.gain = target + (this.gain - target) * coefficient
      for (let channel = 0; channel < channels; channel++) {
        output[channel][frame] = input[channel][frame] * this.gain
      }
    }
  }

  private advance(): void {
    if (this.envelope >= this.openLevel || (this.open && this.envelope >= this.closeLevel)) {
      this.open = true
      this.holdRemaining = this.holdSamples
      return
    }
    if (!this.open) return
    this.holdRemaining--
    if (this.holdRemaining <= 0) this.open = false
  }
}
