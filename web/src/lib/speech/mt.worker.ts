import { BaseStreamer, pipeline } from '@huggingface/transformers'
import type { DataType } from '@huggingface/transformers'

import { configureTransformers, loadingModel } from './hf'
import { attempting, expectLoading, gpuCapabilities, reportLoading, reportRefused, reportWarning } from './loading'
import { exportKey, loadsUpFront, mtRoute, mtRungs, sharedRun, type Export, type MtChoice, type MtKind, type MtRoute, type Sizes } from './models'
import { errorMessage } from '../errors'
import { answerBudget, garbled, type Garbled } from './garbled'
import { firstThatRuns, type Capabilities, type Rung } from './runtime'
import { serve } from './serve'
import type { TranslationLevel } from '../translate/types'
import { parseRuntime } from './wasm'

const MAX_NEW_TOKENS = 384
const THINKING = /<think>[\s\S]*?<\/think>/g
const WARM_UP = { text: 'Hello.', source: 'en', target: 'de' }

interface Limit {
  max_new_tokens: number
  streamer?: BaseStreamer
}

interface Seq2Seq {
  (text: string, options: Limit & { src_lang?: string; tgt_lang?: string }): Promise<{ translation_text: string }[]>
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

interface GenerationOptions extends Limit {
  do_sample: false
  tokenizer_encode_kwargs?: { enable_thinking: false }
}

interface Generator<Message> {
  (messages: Message[], options: GenerationOptions): Promise<{ generated_text: (Message | ChatMessage)[] }[]>
  dispose(): Promise<void>
}

type Model = { kind: 'seq2seq'; run: Seq2Seq } | { kind: 'llm'; run: Generator<ChatMessage> } | { kind: 'translator'; run: Generator<TranslationRequest> }

interface Step {
  model: Model
  source: string
  target: string
}

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
  const rungs = mtRungs(wanted, kind, capabilities, sizes)
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
    await warmUp(model)
  } catch (err) {
    await model.run.dispose()
    throw err
  }
  return model
}

class GeneratedTokens extends BaseStreamer {
  count = 0
  private prompt = true

  override put(): void {
    if (this.prompt) this.prompt = false
    else this.count++
  }

  override end(): void {}
}

const GARBLED: Record<Garbled, string> = {
  empty: 'is empty',
  'token-limit': 'runs into its token limit',
  repetition: 'repeats itself',
}

async function warmUp(model: Model): Promise<void> {
  const tokens = new GeneratedTokens()
  const budget = answerBudget(WARM_UP.text)
  const answer = await translateWith(model, WARM_UP.text, WARM_UP.source, WARM_UP.target, '', { max_new_tokens: budget, streamer: tokens })
  const fault = garbled(answer, tokens.count, budget)
  if (fault) throw new Error(`its translation of "${WARM_UP.text}" ${GARBLED[fault]}: ${JSON.stringify(answer.slice(0, 80))} after ${tokens.count} tokens`)
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

async function pivotSteps(route: Extract<MtRoute, { kind: 'pivot' }>, source: string, target: string): Promise<Step[]> {
  try {
    const into = await modelFor(route.into, 'seq2seq')
    const out = await modelFor(route.out, 'seq2seq')
    return [
      { model: into, source, target: route.via },
      { model: out, source: route.via, target },
    ]
  } catch (err) {
    throw new Error(`${source} to ${target} is translated through ${route.via}, and ${errorMessage(err)}`, { cause: err })
  }
}

async function stepsFor(source: string, target: string): Promise<Step[]> {
  const mt = chosen()
  const route = mtRoute(mt.pairs ?? {}, sharedRun(mt, capabilities, sizes, (primary ?? fallback)?.kind ?? null), source, target)
  switch (route.kind) {
    case 'pair':
      return [{ model: await modelFor(route.pair, 'seq2seq'), source, target }]
    case 'pivot':
      return pivotSteps(route, source, target)
    case 'shared':
      return [{ model: await sharedModel(), source, target }]
    case 'settle-shared':
      await sharedModel()
      return stepsFor(source, target)
  }
}

async function translateAlong(steps: readonly Step[], text: string, system: string): Promise<string> {
  let translated = text
  for (const step of steps) translated = await translateWith(step.model, translated, step.source, step.target, system, { max_new_tokens: MAX_NEW_TOKENS })
  return translated
}

function answerOf(output: { generated_text: { role: string; content: unknown }[] } | undefined, target: string): string {
  const reply = output?.generated_text.at(-1)
  if (reply?.role !== 'assistant' || typeof reply.content !== 'string') throw new Error(`the translation model gave no answer for ${target}`)
  return reply.content.replace(THINKING, '').trim()
}

async function translateWith(model: Model, text: string, source: string, target: string, system: string, limit: Limit): Promise<string> {
  if (model.kind === 'translator') {
    const [output] = await model.run([{ role: 'user', content: [{ type: 'text', source_lang_code: source, target_lang_code: target, text }] }], {
      ...limit,
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
      ...limit,
      do_sample: false,
      tokenizer_encode_kwargs: { enable_thinking: false },
    })
    return answerOf(output, target)
  }

  const type = model.run.model.config.model_type
  if (type !== 'm2m_100' && type !== 'marian') throw new Error(`a ${type} model is not one this app translates with`)
  const options = type === 'm2m_100' ? { ...limit, src_lang: source, tgt_lang: target } : limit

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
      await stepsFor(String(request.source), String(request.target))
      return
    }

    case 'translate': {
      const steps = await stepsFor(String(request.source), String(request.target))
      return [{ text: await translateAlong(steps, String(request.text), String(request.system ?? '')) }]
    }

    default:
      throw new Error(`translation does not know "${request.type}"`)
  }
})
