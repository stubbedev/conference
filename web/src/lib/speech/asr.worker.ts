// Transcription in a worker of its own: Whisper, through transformers.js,
// turned one utterance of 16 kHz PCM into the sentence that was said. The
// model is the one the server serves for the speaker's language, which
// may be a language's own fine-tune, and it is loaded when the speaker's
// language is first heard rather than when the page starts.
//
// Whisper cannot tell what language it is hearing, so every call says
// which one it is. A model that cannot run on this browser's GPU is run
// on the CPU in its 8-bit export; a model that cannot run at all is
// reported with what the runtime said.

import { pipeline } from '@huggingface/transformers'
import type { DataType } from '@huggingface/transformers'

import { configureTransformers } from './hf'
import { toFloat32 } from './pcm'
import { dtypeFor, fallbackToWasm, message, type Device } from './runtime'
import { serve } from './serve'
import { webgpuAvailable } from './webgpu'

interface Transcriber {
  (audio: Float32Array, options: { language: string; task: 'transcribe' }): Promise<{ text: string }>
}

interface Loaded {
  id: string
  transcriber: Transcriber
}

let model = ''
let dtype = ''
let languages: Record<string, string> = {}
let loaded: Loaded | null = null

/**
 * The model a language loads: its own when the server names one for it.
 * The same resolution as models.ts does for the page, which a worker
 * cannot import because that file reaches the page's own API types.
 */
function modelFor(lang: string): string {
  return languages[lang] ?? model
}

/** The sentence in audio, in lang. */
async function transcribe(audio: Int16Array, lang: string): Promise<string> {
  const id = modelFor(lang)
  const transcriber = loaded?.id === id ? loaded.transcriber : await adopt(id)

  const { text } = await transcriber(toFloat32(audio), { language: lang, task: 'transcribe' })
  return text
}

/** Loads the model for id and keeps it as the one in use. */
async function adopt(id: string): Promise<Transcriber> {
  const transcriber = await load(id)
  loaded = { id, transcriber }
  return transcriber
}

/** The model for id, on the GPU when it can be and on the CPU when it cannot. */
async function load(id: string): Promise<Transcriber> {
  let refused = ''

  if (await gpu()) {
    try {
      return await create(id, 'webgpu', dtype)
    } catch (err) {
      if (!fallbackToWasm(err)) throw new Error(`the transcription model ${id} could not start on WebGPU: ${message(err)}`)
      refused = message(err)
    }

    console.warn(`asr: ${id} cannot run on this browser's WebGPU (${refused}); transcribing on the CPU instead`)
  }

  try {
    return await create(id, 'wasm', dtypeFor('wasm', dtype))
  } catch (err) {
    const onDevice = refused ? ` on WebGPU (${refused}) or on the CPU` : ''
    throw new Error(`the transcription model ${id} could not start${onDevice} (${message(err)})`)
  }
}

/** Whether this browser gives the worker a GPU, and not one it cannot use. */
async function gpu(): Promise<boolean> {
  return webgpuAvailable().catch(() => false)
}

async function create(id: string, device: Device, as: string): Promise<Transcriber> {
  const transcriber = await pipeline('automatic-speech-recognition', id, { device, dtype: as as DataType })
  return transcriber as Transcriber
}

serve(async (request) => {
  switch (request.type) {
    case 'init': {
      configureTransformers(String(request.base))
      model = String(request.model)
      dtype = String(request.dtype)
      languages = (request.languages ?? {}) as Record<string, string>

      await adopt(modelFor(String(request.lang)))
      return
    }

    case 'transcribe':
      return [{ text: await transcribe(request.audio as Int16Array, String(request.lang)) }]

    default:
      throw new Error(`transcription does not know "${request.type}"`)
  }
})
