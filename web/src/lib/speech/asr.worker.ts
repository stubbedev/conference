import { pipeline } from '@huggingface/transformers'
import type { DataType } from '@huggingface/transformers'

import { configureTransformers, loadingModel } from './hf'
import { attempting, expectLoading, gpuCapabilities, reportLoading, reportRefused } from './loading'
import { asrRungs, exportKey, type AsrChoice, type AsrRung, type AsrTier, type Sizes } from './models'
import { toFloat32 } from './pcm'
import { errorMessage } from '../errors'
import { firstThatRuns, type Capabilities } from './runtime'
import { serve } from './serve'
import { RATE } from './vad'
import { parseRuntime } from './wasm'

const TOKENS_PER_SECOND = 10
const TOKEN_SLACK = 10
const WARM_UP_SECONDS = 1

interface Transcriber {
  (audio: Float32Array, options: { language: string; task: 'transcribe'; max_new_tokens: number }): Promise<{ text: string }>
  dispose(): Promise<void>
}

interface Loaded {
  rung: AsrRung
  transcriber: Transcriber
}

let choice: AsrChoice | null = null
let capabilities: Capabilities = { gpu: false, halves: false }
let sizes: Sizes = {}
let floor: AsrTier = 'primary'
let loaded: Loaded | null = null
const refused = new Set<string>()

function rungKey(rung: AsrRung): string {
  return `${rung.device}:${exportKey(rung)}`
}

function rungsLeft(lang: string): AsrRung[] {
  if (!choice) throw new Error('transcription was asked before it was set up')
  return asrRungs(choice, lang, capabilities, sizes, floor).filter((rung) => !refused.has(rungKey(rung)))
}

async function ensureLoaded(lang: string): Promise<Loaded> {
  const rungs = rungsLeft(lang)
  if (loaded && rungs[0] && rungKey(loaded.rung) === rungKey(rungs[0])) return loaded

  const previous = loaded
  loaded = null
  await previous?.transcriber.dispose()

  try {
    loaded = await firstThatRuns(
      rungs,
      (rung) => attempting(rung, () => start(rung, lang)),
      (rung, err) => {
        refused.add(rungKey(rung))
        reportRefused('transcription', rung.model, rung, err)
      },
    )
    return loaded
  } catch (err) {
    throw new Error(`transcribing ${lang} could not start: ${errorMessage(err)}`, { cause: err })
  }
}

function run(transcriber: Transcriber, audio: Float32Array, lang: string): Promise<{ text: string }> {
  const seconds = audio.length / RATE
  return transcriber(audio, { language: lang, task: 'transcribe', max_new_tokens: Math.ceil(seconds * TOKENS_PER_SECOND) + TOKEN_SLACK })
}

async function start(rung: AsrRung, lang: string): Promise<Loaded> {
  expectLoading(exportKey(rung))
  const transcriber = (await loadingModel(() =>
    pipeline('automatic-speech-recognition', rung.model, {
      device: rung.device,
      dtype: rung.dtype as DataType,
      progress_callback: reportLoading,
    }),
  )) as unknown as Transcriber

  try {
    await run(transcriber, new Float32Array(RATE * WARM_UP_SECONDS), lang)
  } catch (err) {
    await transcriber.dispose()
    throw err
  }
  return { rung, transcriber }
}

serve(async (request) => {
  const lang = String(request.lang)

  switch (request.type) {
    case 'init': {
      configureTransformers(String(request.base), parseRuntime(request.runtime))
      choice = request.asr as AsrChoice
      sizes = request.sizes as Sizes
      if (request.gpu) capabilities = await gpuCapabilities('transcription')
      await ensureLoaded(lang)
      return
    }

    case 'transcribe': {
      const { transcriber } = await ensureLoaded(lang)
      const { text } = await run(transcriber, toFloat32(request.audio as Int16Array), lang)
      return [{ text }]
    }

    case 'step-down': {
      if (!choice?.fallback || loaded?.rung.tier === 'fallback') return [{ model: null }]
      floor = 'fallback'
      const { rung } = await ensureLoaded(lang)
      return [{ model: rung.model }]
    }

    default:
      throw new Error(`transcription does not know "${request.type}"`)
  }
})
