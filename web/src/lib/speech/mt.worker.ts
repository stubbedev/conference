import { pipeline } from '@huggingface/transformers'
import type { DataType } from '@huggingface/transformers'

import { configureTransformers } from './hf'
import { reportLoading } from './loading'
import { pairFor, type Export, type MtChoice } from './models'
import { dtypeFor, fallbackToWasm, message, needsHalves, withoutHalves, type Device } from './runtime'
import { serve } from './serve'
import { webgpuAvailable, webgpuHalves } from './webgpu'

const MAX_NEW_TOKENS = 384
const THINKING = /<think>[\s\S]*?<\/think>/g

interface Seq2Seq {
  (text: string, options?: { src_lang: string; tgt_lang: string }): Promise<{ translation_text: string }[]>
  model: { config: { model_type: string } }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface Generator {
  (
    messages: ChatMessage[],
    options: { max_new_tokens: number; do_sample: false; tokenizer_encode_kwargs: { enable_thinking: false } },
  ): Promise<{ generated_text: ChatMessage[] }[]>
}

type Model = { kind: 'seq2seq'; run: Seq2Seq } | { kind: 'llm'; run: Generator }

let choice: MtChoice | null = null
let device: Device = 'webgpu'
let halves = true
const models = new Map<string, Promise<Model>>()

function chosen(): MtChoice {
  if (!choice) throw new Error('translation was asked before it was set up')
  return choice
}

function modelFor(wanted: Export, kind: 'seq2seq' | 'llm'): Promise<Model> {
  const known = models.get(wanted.model)
  if (known) return known

  const pending = load(wanted, kind).catch((err: unknown) => {
    models.delete(wanted.model)
    throw err
  })
  models.set(wanted.model, pending)
  return pending
}

async function load(wanted: Export, kind: 'seq2seq' | 'llm'): Promise<Model> {
  if (kind === 'llm' && device !== 'webgpu') {
    throw new Error(`the translation model ${wanted.model} is a language model, which needs WebGPU`)
  }

  const dtype = (kind === 'llm' && !halves ? withoutHalves(wanted.dtype) : dtypeFor(device, wanted.dtype)) as DataType
  try {
    if (kind === 'llm') {
      const run = await pipeline('text-generation', wanted.model, { device, dtype, progress_callback: reportLoading })
      return { kind, run: run as unknown as Generator }
    }
    const run = await pipeline('translation', wanted.model, { device, dtype, progress_callback: reportLoading })
    return { kind, run: run as unknown as Seq2Seq }
  } catch (err) {
    if (device === 'webgpu' && kind === 'seq2seq' && fallbackToWasm(err)) {
      console.warn(`mt: ${wanted.model} cannot run on this browser's WebGPU (${message(err)}); translating on the CPU instead`)
      device = 'wasm'
      return load(wanted, kind)
    }
    const on = device === 'webgpu' ? 'WebGPU' : 'the CPU'
    throw new Error(`the translation model ${wanted.model} could not start on ${on}: ${message(err)}`)
  }
}

async function translateWith(model: Model, text: string, source: string, target: string, system: string): Promise<string> {
  if (model.kind === 'llm') {
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: text },
    ]
    const [output] = await model.run(messages, {
      max_new_tokens: MAX_NEW_TOKENS,
      do_sample: false,
      tokenizer_encode_kwargs: { enable_thinking: false },
    })
    const reply = output?.generated_text.at(-1)
    if (reply?.role !== 'assistant') throw new Error(`the translation model gave no answer for ${target}`)
    return reply.content.replace(THINKING, '').trim()
  }

  const type = model.run.model.config.model_type
  const options = type === 'm2m_100' ? { src_lang: source, tgt_lang: target } : undefined
  if (type !== 'm2m_100' && type !== 'marian') throw new Error(`a ${type} model is not one this app translates with`)

  const [translated] = await model.run(text, options)
  if (!translated) throw new Error(`the translation model translated nothing into ${target}`)
  return translated.translation_text
}

serve(async (request) => {
  switch (request.type) {
    case 'init': {
      configureTransformers(String(request.base))
      choice = request.mt as MtChoice
      if (!(await webgpuAvailable().catch(() => false))) device = 'wasm'
      halves = await webgpuHalves().catch(() => false)
      if (choice.kind === 'seq2seq' && !halves && needsHalves(choice.dtype)) device = 'wasm'
      await modelFor(choice, choice.kind)
      return
    }

    case 'translate': {
      const mt = chosen()
      const source = String(request.source)
      const target = String(request.target)
      const pair = pairFor(mt, source, target)
      const model = pair ? await modelFor(pair, 'seq2seq') : await modelFor(mt, mt.kind)
      return [{ text: await translateWith(model, String(request.text), source, target, String(request.system ?? '')) }]
    }

    default:
      throw new Error(`translation does not know "${request.type}"`)
  }
})
