// A Piper voice: one VITS model per language, served by this app, that
// turns a sentence into PCM. The sentence is phonemized first by espeak-ng
// compiled to WebAssembly, because the model takes phoneme ids rather than
// letters, and each voice's JSON says which espeak voice writes them, at
// what rate it speaks and how the noise and the length of its speech are
// scaled.
//
// The phonemizer is a program rather than a library: it is handed its
// arguments once and exits, so every call builds one, which also keeps two
// calls from writing over each other's output. The voice's session is
// built once and kept, because loading a voice costs far more than
// speaking a sentence, and it is tried on the GPU before the CPU for the
// same reason: a sentence should be spoken as soon as it is translated.

import { configureOrt, ort } from './ort'
import { lengthsDims, phonemeIds, readVoiceConfig, speakerId, type VoiceConfig } from './piper-voice'
import { fallbackToWasm, message } from './runtime'
import { fixed, size } from './tensor'
import { modelURL } from './urls'
import type { VoiceChoice } from '../translate/types'

/** Where the build script puts the phonemizer's own files. */
const PHONEMIZER_DIR = '/piper/'

/**
 * Where the phonemizer finds espeak-ng's data inside its own file system:
 * its build preloads the data at this path, whatever URL it was served
 * from.
 */
const ESPEAK_DATA = '/espeak-ng-data'

/** The scales a voice is spoken with, in the order Piper takes them. */
const SCALES = 3

/** The phonemizer as its build exports it: an Emscripten program with callMain. */
interface Phonemizer {
  callMain(args: string[]): unknown
}

interface PhonemizerOptions {
  print?: (line: string) => void
  printErr?: (line: string) => void
  locateFile?: (file: string) => string
}

type CreatePhonemizer = (options: PhonemizerOptions) => Promise<Phonemizer>

interface Voice {
  config: VoiceConfig
  session: ort.InferenceSession
}

/** Speech as a player needs it: mono PCM at the voice's own rate. */
export interface Spoken {
  pcm: Float32Array<ArrayBuffer>
  rate: number
}

export class Piper {
  private readonly base: string
  private readonly voices = new Map<string, Promise<Voice>>()

  constructor(base: string) {
    this.base = base
  }

  /** Speaks text in voice, whose speaker is chosen by choice. */
  async speak(text: string, voice: string, choice: VoiceChoice): Promise<Spoken> {
    const { config, session } = await this.voice(voice)

    const ids = await phonemize(text, config)
    const result = await session.run(feeds(session, config, ids, choice))
    const output = result.output
    if (!output) throw new Error(`the voice ${voice} spoke nothing`)

    const data = (output as ort.Tensor).data
    if (!(data instanceof Float32Array) || data.length === 0) {
      throw new Error(`the voice ${voice} spoke something that is not audio`)
    }

    return { pcm: Float32Array.from(data), rate: config.sampleRate }
  }

  private voice(name: string): Promise<Voice> {
    const known = this.voices.get(name)
    if (known) return known

    const pending = load(this.base, name).catch((err: unknown) => {
      this.voices.delete(name)
      throw err
    })

    this.voices.set(name, pending)
    return pending
  }
}

/** Reads a voice's JSON and starts its session, keeping neither until it has both. */
async function load(base: string, name: string): Promise<Voice> {
  const settings = modelURL(base, 'piper', `${name}.onnx.json`)
  const response = await fetch(settings)
  if (!response.ok) throw new Error(`the voice ${name} has no settings: ${response.status} ${response.statusText}`)

  const config = readVoiceConfig(await response.json())
  return { config, session: await session(modelURL(base, 'piper', `${name}.onnx`)) }
}

/** Starts url on the GPU, or on the CPU when this browser's GPU refuses it. */
async function session(url: string): Promise<ort.InferenceSession> {
  configureOrt()

  let refusal: string
  try {
    return await ort.InferenceSession.create(url, { executionProviders: ['webgpu', 'wasm'] })
  } catch (err) {
    if (!fallbackToWasm(err)) throw new Error(`the voice model ${url} could not start: ${message(err)}`)
    refusal = message(err)
  }

  console.warn(`tts: ${url} cannot run on this browser's WebGPU (${refusal}); speaking on the CPU instead`)
  try {
    return await ort.InferenceSession.create(url, { executionProviders: ['wasm'] })
  } catch (err) {
    throw new Error(`the voice model ${url} could not start on the GPU (${refusal}) or on the CPU (${message(err)})`)
  }
}

/** The phoneme ids of one sentence, in the voice's own espeak voice. */
async function phonemize(text: string, config: VoiceConfig): Promise<number[]> {
  const lines: string[] = []
  const complaints: string[] = []
  const create = await phonemizer()

  const module = await create({
    print: (line) => lines.push(line),
    printErr: (line) => complaints.push(line),
    locateFile: (file) => PHONEMIZER_DIR + file,
  })

  module.callMain(['-l', config.espeak, '--input', JSON.stringify([{ text }]), '--espeak_data', ESPEAK_DATA])

  const ids = phonemeIds(lines)
  if (ids.length === 0) {
    const said = complaints.join(' ').trim()
    throw new Error(`the voice could not phonemize "${text}"${said ? `: ${said}` : ''}`)
  }

  return ids
}

/** A fresh phonemizer: it runs once and exits, so nothing is shared with the last call. */
async function phonemizer(): Promise<CreatePhonemizer> {
  // The phonemizer is built by Emscripten and ships no type declarations.
  // @ts-expect-error see above
  const module = await import('@diffusionstudio/piper-wasm/build/piper_phonemize.js')
  return (module.default ?? module) as CreatePhonemizer
}

/** What the voice model is asked to say, in the shapes it declares. */
function feeds(
  session: ort.InferenceSession,
  config: VoiceConfig,
  ids: readonly number[],
  choice: VoiceChoice,
): Record<string, ort.Tensor> {
  const length = ids.length
  const lengths = lengthsDims(declared(session, 'input_lengths'), length)
  const speakerDims = lengthsDims(declared(session, 'sid'), 1)

  const asked: Record<string, ort.Tensor> = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, (id) => BigInt(id)), [1, length]),
    input_lengths: new ort.Tensor('int64', fixed(size(lengths), length), lengths),
    scales: new ort.Tensor('float32', Float32Array.from([config.noiseScale, config.lengthScale, config.noiseWidth]), [SCALES]),
  }

  const speaker = speakerId(config.speakers, choice)
  if (speaker !== null) asked.sid = new ort.Tensor('int64', fixed(size(speakerDims), speaker), speakerDims)

  const feeds: Record<string, ort.Tensor> = {}
  for (const name of session.inputNames) {
    const tensor = asked[name]
    if (tensor) feeds[name] = tensor
  }
  return feeds
}

/** The shape a model declares for one of its inputs, if it declares one. */
function declared(session: ort.InferenceSession, name: string): readonly number[] | undefined {
  const input = session.inputMetadata.find((value) => value.name === name)
  if (!input || !input.isTensor) return undefined

  return input.shape.map((dim) => (typeof dim === 'number' ? dim : 0))
}
