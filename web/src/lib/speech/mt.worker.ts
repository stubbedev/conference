import { pipeline } from '@huggingface/transformers'
import type { DataType } from '@huggingface/transformers'

import { configureTransformers, loadingModel } from './hf'
import { attempting, expectLoading, gpuCapabilities, reportLoading, reportRefused, reportWarning } from './loading'
import { exportKey, hostedIn, loadsUpFront, pairFor, type Export, type MtChoice, type MtKind, type Sizes } from './models'
import { errorMessage } from '../errors'
import { firstThatRuns, rungsFor, type Capabilities, type Rung } from './runtime'
import { serve } from './serve'
import type { TranslationLevel } from '../translate/types'
import { parseRuntime } from './wasm'

const MAX_NEW_TOKENS = 384
const THINKING = /<think>[\s\S]*?<\/think>/g
const WARM_UP = { text: 'Hello.', source: 'en', target: 'de' }

interface Seq2Seq {
  (text: string, options?: { src_lang: string; tgt_lang: string }): Promise<{ translation_text: string }[]>
  model: { config: { model_type: string } }
  dispose(): Promise<void>
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

interface TranslationRequest {
  role: 'user'
  content: [{ type: 'text'; source_lang_code: string; target_lang_code: string; text: string }]
}

interface GenerationOptions {
  max_new_tokens: number
  do_sample: false
  tokenizer_encode_kwargs?: { enable_thinking: false }
}

interface Generator<Message> {
  (messages: Message[], options: GenerationOptions): Promise<{ generated_text: (Message | ChatMessage)[] }[]>
  dispose(): Promise<void>
}

type Model = { kind: 'seq2seq'; run: Seq2Seq } | { kind: 'llm'; run: Generator<ChatMessage> } | { kind: 'translator'; run: Generator<TranslationRequest> }

let choice: MtChoice | null = null
let capabilities: Capabilities = { gpu: false, halves: false }
let sizes: Sizes = {}
let primary: Model | null = null
let fallback: Model | null = null
const models = new Map<string, Promise<Model>>()

function chosen(): MtChoice {
  if (!choice) throw new Error('translation was asked before it was set up')
  return choice
}

function modelFor(wanted: Export, kind: MtKind): Promise<Model> {
  const known = models.get(wanted.model)
  if (known) return known

  const pending = load(wanted, kind).catch((err: unknown) => {
    models.delete(wanted.model)
    throw err
  })
  models.set(wanted.model, pending)
  return pending
}

async function load(wanted: Export, kind: MtKind): Promise<Model> {
  const rungs = rungsFor(wanted.dtype, capabilities, hostedIn(sizes, wanted.model), kind === 'seq2seq')
  try {
    return await firstThatRuns(
      rungs,
      (rung) => attempting(rung, () => start(wanted.model, kind, rung)),
      (rung, err) => reportRefused('translation', wanted.model, rung, err),
    )
  } catch (err) {
    throw new Error(`the translation model ${wanted.model} could not start: ${errorMessage(err)}`, { cause: err })
  }
}

async function start(name: string, kind: MtKind, rung: Rung): Promise<Model> {
  expectLoading(name, exportKey({ model: name, dtype: rung.dtype }))
  const options = { device: rung.device, dtype: rung.dtype as DataType, progress_callback: reportLoading }
  const model: Model =
    kind === 'seq2seq'
      ? { kind, run: (await loadingModel(() => pipeline('translation', name, options))) as unknown as Seq2Seq }
      : kind === 'llm'
        ? { kind, run: (await loadingModel(() => pipeline('text-generation', name, options))) as unknown as Generator<ChatMessage> }
        : { kind, run: (await loadingModel(() => pipeline('text-generation', name, options))) as unknown as Generator<TranslationRequest> }

  try {
    await translateWith(model, WARM_UP.text, WARM_UP.source, WARM_UP.target, '')
  } catch (err) {
    await model.run.dispose()
    throw err
  }
  return model
}

async function prepare(mt: MtChoice): Promise<TranslationLevel> {
  if (!loadsUpFront(mt)) return 'plain'
  return (await sharedModel()).kind === 'llm' ? 'prompted' : 'plain'
}

async function sharedModel(): Promise<Model> {
  const ready = primary ?? fallback
  if (ready) return ready

  const mt = chosen()
  try {
    primary = await modelFor(mt, mt.kind)
    return primary
  } catch (err) {
    if (!mt.fallback) throw err
    reportWarning(`${errorMessage(err)}, so translation uses ${mt.fallback.model} instead`)
    fallback = await modelFor(mt.fallback, 'seq2seq')
    return fallback
  }
}

function modelForPair(source: string, target: string): Promise<Model> {
  const pair = pairFor(chosen(), source, target)
  return pair ? modelFor(pair, 'seq2seq') : sharedModel()
}

function answerOf(output: { generated_text: { role: string; content: unknown }[] } | undefined, target: string): string {
  const reply = output?.generated_text.at(-1)
  if (reply?.role !== 'assistant' || typeof reply.content !== 'string') throw new Error(`the translation model gave no answer for ${target}`)
  return reply.content.replace(THINKING, '').trim()
}

async function translateWith(model: Model, text: string, source: string, target: string, system: string): Promise<string> {
  if (model.kind === 'translator') {
    const [output] = await model.run([{ role: 'user', content: [{ type: 'text', source_lang_code: source, target_lang_code: target, text }] }], {
      max_new_tokens: MAX_NEW_TOKENS,
      do_sample: false,
    })
    return answerOf(output, target)
  }

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
    return answerOf(output, target)
  }

  const type = model.run.model.config.model_type
  if (type !== 'm2m_100' && type !== 'marian') throw new Error(`a ${type} model is not one this app translates with`)
  const options = type === 'm2m_100' ? { src_lang: source, tgt_lang: target } : undefined

  const [translated] = await model.run(text, options)
  if (!translated) throw new Error(`the translation model translated nothing into ${target}`)
  return translated.translation_text
}

serve(async (request) => {
  switch (request.type) {
    case 'init': {
      configureTransformers(String(request.base), parseRuntime(request.runtime))
      choice = request.mt as MtChoice
      sizes = request.sizes as Sizes
      if (request.gpu) capabilities = await gpuCapabilities('translation')
      return [{ level: await prepare(choice) }]
    }

    case 'warm-up': {
      await modelForPair(String(request.source), String(request.target))
      return
    }

    case 'translate': {
      const source = String(request.source)
      const target = String(request.target)
      const model = await modelForPair(source, target)
      return [{ text: await translateWith(model, String(request.text), source, target, String(request.system ?? '')) }]
    }

    default:
      throw new Error(`translation does not know "${request.type}"`)
  }
})
