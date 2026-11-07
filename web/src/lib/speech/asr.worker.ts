import { pipeline } from '@huggingface/transformers'
import type { DataType } from '@huggingface/transformers'

import { configureTransformers } from './hf'
import { reportLoading } from './loading'
import { asrExport, type AsrChoice, type AsrTier, type Export } from './models'
import { toFloat32 } from './pcm'
import { dtypeFor, fallbackToWasm, message, type Device } from './runtime'
import { serve } from './serve'
import { webgpuAvailable } from './webgpu'

interface Transcriber {
  (audio: Float32Array, options: { language: string; task: 'transcribe' }): Promise<{ text: string }>
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
  return loaded.transcriber
}

async function load(lang: string): Promise<Loaded> {
  const wanted = exportFor(lang)
  try {
    const transcriber = await pipeline('automatic-speech-recognition', wanted.model, {
      device,
      dtype: wanted.dtype as DataType,
      progress_callback: reportLoading,
    })
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
      configureTransformers(String(request.base))
      choice = request.asr as AsrChoice
      if (!(await webgpuAvailable().catch(() => false))) runOnCpu()
      await transcriberFor(lang)
      return
    }

    case 'transcribe': {
      const transcriber = await transcriberFor(lang)
      const { text } = await transcriber(toFloat32(request.audio as Int16Array), { language: lang, task: 'transcribe' })
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
