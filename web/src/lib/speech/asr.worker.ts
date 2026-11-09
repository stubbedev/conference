import { pipeline } from '@huggingface/transformers'
import type { DataType } from '@huggingface/transformers'

import { configureTransformers, loadingModel } from './hf'
import { expectLoading, reportLoading } from './loading'
import { asrExport, exportKey, type AsrChoice, type AsrTier, type Export } from './models'
import { toFloat32 } from './pcm'
import { dtypeFor, fallbackToWasm, message, needsHalves, type Device } from './runtime'
import { serve } from './serve'
import { RATE } from './vad'
import { parseRuntime } from './wasm'
import { webgpuAvailable, webgpuHalves } from './webgpu'

const TOKENS_PER_SECOND = 10
const TOKEN_SLACK = 10
const WARM_UP_SECONDS = 1

interface Transcriber {
  (audio: Float32Array, options: { language: string; task: 'transcribe'; max_new_tokens: number }): Promise<{ text: string }>
  dispose(): Promise<void>
}

interface Loaded {
  key: string
  transcriber: Transcriber
}

let choice: AsrChoice | null = null
let device: Device = 'webgpu'
let tier: AsrTier = 'primary'
let loaded: Loaded | null = null

function exportFor(lang: string): Export {
  if (!choice) throw new Error('transcription was asked before it was set up')
  const wanted = asrExport(choice, tier, lang)
  if (!wanted) throw new Error(`there is no ${tier} transcription model`)
  return { model: wanted.model, dtype: dtypeFor(device, wanted.dtype) }
}

async function chooseDevice(asr: AsrChoice): Promise<void> {
  if (!(await webgpuAvailable().catch(() => false))) {
    runOnCpu()
    return
  }
  if (!needsHalves(asr.dtype) || (await webgpuHalves().catch(() => false))) return

  if (asr.fallback && !needsHalves(asr.fallback.dtype)) tier = 'fallback'
  else runOnCpu()
}

function runOnCpu(): void {
  device = 'wasm'
  if (choice?.fallback) tier = 'fallback'
}

async function transcriberFor(lang: string): Promise<Transcriber> {
  const wanted = exportFor(lang)
  if (loaded?.key === `${wanted.model}:${wanted.dtype}`) return loaded.transcriber

  const previous = loaded
  loaded = null
  await previous?.transcriber.dispose()

  loaded = await load(lang)
  await run(loaded.transcriber, new Float32Array(RATE * WARM_UP_SECONDS), lang)
  return loaded.transcriber
}

function run(transcriber: Transcriber, audio: Float32Array, lang: string): Promise<{ text: string }> {
  const seconds = audio.length / RATE
  return transcriber(audio, { language: lang, task: 'transcribe', max_new_tokens: Math.ceil(seconds * TOKENS_PER_SECOND) + TOKEN_SLACK })
}

async function load(lang: string): Promise<Loaded> {
  const wanted = exportFor(lang)
  expectLoading(exportKey(wanted))
  try {
    const transcriber = await loadingModel(() =>
      pipeline('automatic-speech-recognition', wanted.model, {
        device,
        dtype: wanted.dtype as DataType,
        progress_callback: reportLoading,
      }),
    )
    return { key: `${wanted.model}:${wanted.dtype}`, transcriber: transcriber as unknown as Transcriber }
  } catch (err) {
    if (device === 'webgpu' && fallbackToWasm(err)) {
      console.warn(`asr: ${wanted.model} cannot run on this browser's WebGPU (${message(err)}); transcribing on the CPU instead`)
      runOnCpu()
      return load(lang)
    }
    const on = device === 'webgpu' ? 'WebGPU' : 'the CPU'
    throw new Error(`the transcription model ${wanted.model} could not start on ${on}: ${message(err)}`)
  }
}

serve(async (request) => {
  const lang = String(request.lang)

  switch (request.type) {
    case 'init': {
      configureTransformers(String(request.base), parseRuntime(request.runtime))
      choice = request.asr as AsrChoice
      await chooseDevice(choice)
      await transcriberFor(lang)
      return
    }

    case 'transcribe': {
      const transcriber = await transcriberFor(lang)
      const { text } = await run(transcriber, toFloat32(request.audio as Int16Array), lang)
      return [{ text }]
    }

    case 'step-down': {
      if (tier === 'fallback' || !choice?.fallback) return [{ model: null }]
      tier = 'fallback'
      await transcriberFor(lang)
      return [{ model: exportFor(lang).model }]
    }

    default:
      throw new Error(`transcription does not know "${request.type}"`)
  }
})
