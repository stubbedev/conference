// Translation in a worker of its own: one sentence in a speaker's
// language, the same sentence in a listener's, through the multilingual
// model the server serves. A model that cannot run on this browser's GPU
// is run on the CPU in its 8-bit export; one that cannot run at all is
// reported with what the runtime said.

import { pipeline } from '@huggingface/transformers'
import type { DataType } from '@huggingface/transformers'

import { configureTransformers } from './hf'
import { dtypeFor, fallbackToWasm, message, type Device } from './runtime'
import { serve } from './serve'
import { webgpuAvailable } from './webgpu'

interface Translator {
  (text: string, options: { src_lang: string; tgt_lang: string }): Promise<{ translation_text: string }[]>
}

let model = ''
let dtype = ''
let translator: Translator | null = null

/** One sentence translated, or the reason it could not be. */
async function translate(text: string, source: string, target: string): Promise<string> {
  if (!translator) throw new Error('translation was asked before the model was loaded')

  const [translated] = await translator(text, { src_lang: source, tgt_lang: target })
  if (!translated) throw new Error(`the translation model translated nothing into ${target}`)

  return translated.translation_text
}

/** The model on the GPU when it can be and on the CPU when it cannot. */
async function load(): Promise<Translator> {
  let refused = ''

  if (await gpu()) {
    try {
      return await create('webgpu', dtype)
    } catch (err) {
      if (!fallbackToWasm(err)) throw new Error(`the translation model ${model} could not start on WebGPU: ${message(err)}`)
      refused = message(err)
    }

    console.warn(`mt: ${model} cannot run on this browser's WebGPU (${refused}); translating on the CPU instead`)
  }

  try {
    return await create('wasm', dtypeFor('wasm', dtype))
  } catch (err) {
    const onDevice = refused ? ` on WebGPU (${refused}) or on the CPU` : ''
    throw new Error(`the translation model ${model} could not start${onDevice} (${message(err)})`)
  }
}

async function create(device: Device, as: string): Promise<Translator> {
  const translator = await pipeline('translation', model, { device, dtype: as as DataType })
  return translator as Translator
}

/** Whether this browser gives the worker a GPU, and not one it cannot use. */
async function gpu(): Promise<boolean> {
  return webgpuAvailable().catch(() => false)
}

serve(async (request) => {
  switch (request.type) {
    case 'init': {
      configureTransformers(String(request.base))
      model = String(request.model)
      dtype = String(request.dtype)
      translator = await load()
      return
    }

    case 'translate':
      return [{ text: await translate(String(request.text), String(request.source), String(request.target)) }]

    default:
      throw new Error(`translation does not know "${request.type}"`)
  }
})
