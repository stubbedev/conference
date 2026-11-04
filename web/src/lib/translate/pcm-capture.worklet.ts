// AudioWorklet that turns one speaker's audio into 20 ms chunks of
// 16-bit PCM for the speech service. The AudioContext runs at 16 kHz, so
// the browser has already resampled the input.

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  abstract process(inputs: Float32Array[][]): boolean
}

declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void

const CHUNK = 320

class PcmCapture extends AudioWorkletProcessor {
  private chunk = new Int16Array(CHUNK)
  private filled = 0

  process(inputs: Float32Array[][]): boolean {
    const samples = inputs[0]?.[0]
    if (!samples) return true

    for (const sample of samples) {
      const clamped = Math.max(-1, Math.min(1, sample))
      this.chunk[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
      if (this.filled === CHUNK) {
        this.port.postMessage(this.chunk.buffer, [this.chunk.buffer])
        this.chunk = new Int16Array(CHUNK)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCapture)
