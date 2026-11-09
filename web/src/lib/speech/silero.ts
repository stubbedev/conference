// The Silero voice activity model, run on ONNX Runtime Web in the member's
// browser: 32 ms of 16 kHz audio in, how likely that frame is speech out.
// The same model the speech service uses on its side, so a browser that
// runs the engines itself cuts utterances the same way.
//
// The model is stateful: every frame is judged with what the ones before
// it said, so one Silero belongs to one speaker's stream, which is what a
// worker has for as long as it lives. It runs on the CPU: a frame every
// 32 ms is nothing, and a GPU session would cost more to keep alive than
// it saves.
//
// Two things travel between frames: the recurrent state the model hands
// back, and the last 64 samples of the frame before, which the model reads
// as the start of the next one. Without that tail a frame is judged out of
// context and speech scores as noise.
//
// The model's own shape decides what is fed to it, because the exports in
// the wild differ: the current one carries a single recurrent state, older
// ones an LSTM's h and c, and either may declare a sample rate.

import { ort } from './ort'
import { toFloat32, withContext } from './pcm'
import { fixed, known, size } from './tensor'
import { FRAME, RATE } from './vad'

/** Samples of the frame before that the model reads as context. */
export const CONTEXT = 64

/** The state a voice model carries between frames, by input name. */
const STATE_SHAPES: Record<string, readonly number[]> = {
  state: [2, 1, 128],
  h: [2, 1, 64],
  c: [2, 1, 64],
}

/** The shape each input takes when the model does not say. */
const INPUT_SHAPES: Record<string, readonly number[]> = {
  input: [1, CONTEXT + FRAME],
  sr: [],
  ...STATE_SHAPES,
}

/** The probability the model is asked for, and the only output that is not state. */
const PROBABILITY = 'output'

export class Silero {
  private readonly session: ort.InferenceSession
  private readonly faces: Map<string, readonly number[]>
  /** Which output carries each stateful input's next state. */
  private readonly carried: Map<string, string>
  private state: Map<string, ort.Tensor>
  private context: Float32Array

  private constructor(session: ort.InferenceSession, faces: Map<string, readonly number[]>) {
    this.session = session
    this.faces = faces
    this.carried = carriedBy(session)
    this.state = this.zeroState()
    this.context = new Float32Array(Math.max((this.faces.get('input')?.[1] ?? CONTEXT + FRAME) - FRAME, 0))
  }

  /** Starts model, fetched from url, which the server serves itself. */
  static async load(url: string, model: Uint8Array): Promise<Silero> {
    let session: ort.InferenceSession
    try {
      session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
    } catch (err) {
      throw new Error(`the voice detection model ${url} could not start`, { cause: err })
    }

    const faces = new Map<string, readonly number[]>()
    for (const input of session.inputMetadata) {
      if (input.isTensor) faces.set(input.name, resolve(input.shape, INPUT_SHAPES[input.name]))
    }

    return new Silero(session, faces)
  }

  /** How likely frame is speech, from 0 to 1. */
  async probability(frame: Int16Array): Promise<number> {
    if (frame.length !== FRAME) throw new Error(`voice detection reads ${FRAME} samples, not ${frame.length}`)

    const results = await this.session.run(this.feeds(frame))
    for (const [input, output] of this.carried) {
      const state = results[output]
      if (state) this.state.set(input, state as ort.Tensor)
    }

    const output = results[PROBABILITY]
    if (!output) throw new Error('the voice detection model returned no probability')

    const data = (output as ort.Tensor).data
    if (!(data instanceof Float32Array) || data.length === 0) {
      throw new Error('the voice detection model returned something that is not a probability')
    }

    return Math.min(Math.max(data[0], 0), 1)
  }

  private feeds(frame: Int16Array): Record<string, ort.Tensor> {
    const feeds: Record<string, ort.Tensor> = {}
    for (const name of this.session.inputNames) {
      const dims = this.faces.get(name)
      if (name === 'input') {
        const input = withContext(this.context, toFloat32(frame))
        this.context = input.slice(input.length - this.context.length)
        feeds[name] = new ort.Tensor('float32', input, dims)
      } else if (name === 'sr') feeds[name] = new ort.Tensor('int64', fixed(size(dims), RATE), dims)
      else {
        const state = this.state.get(name)
        if (state) feeds[name] = state
      }
    }
    return feeds
  }

  private zeroState(): Map<string, ort.Tensor> {
    const state = new Map<string, ort.Tensor>()
    for (const name of this.session.inputNames) {
      if (name === 'input' || name === 'sr') continue

      const dims = this.faces.get(name)
      if (dims) state.set(name, new ort.Tensor('float32', new Float32Array(size(dims)), dims))
    }
    return state
  }
}

/** Pairs each stateful input with the output that carries its next value. */
function carriedBy(session: ort.InferenceSession): Map<string, string> {
  const stateful = session.inputNames.filter((name) => name !== 'input' && name !== 'sr')
  const updated = session.outputNames.filter((name) => name !== PROBABILITY)

  const carried = new Map<string, string>()
  for (let i = 0; i < stateful.length && i < updated.length; i++) carried.set(stateful[i], updated[i])
  return carried
}

/** The model's declared shape, with anything it leaves open taken from fallback. */
function resolve(shape: readonly (number | string)[], fallback: readonly number[] | undefined): readonly number[] {
  if (shape.length === 0) return fallback ?? [1]

  return shape.map((dim, i) => (known(dim) ? dim : (fallback?.[i] ?? 1)))
}
