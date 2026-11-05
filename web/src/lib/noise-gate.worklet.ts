import { NoiseGate } from './noise-gate.ts'

declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort
  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean
}

declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void

declare const sampleRate: number

class NoiseGateProcessor extends AudioWorkletProcessor {
  private readonly gate = new NoiseGate(sampleRate)

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    this.gate.process(inputs[0] ?? [], outputs[0] ?? [])
    return true
  }
}

registerProcessor('noise-gate', NoiseGateProcessor)
