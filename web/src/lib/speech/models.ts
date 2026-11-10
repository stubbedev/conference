import type { Language } from '../translate/languages.ts'
import { rungsFor, type Capabilities, type Rung } from './runtime.ts'

export interface Export {
  model: string
  dtype: string
}

export interface ModelChoice extends Export {
  languages?: Record<string, string>
}

export interface AsrChoice extends ModelChoice {
  fallback?: ModelChoice
}

export type MtKind = 'translator' | 'seq2seq' | 'llm'

export interface MtChoice extends Export {
  kind: MtKind
  fallback?: Export
  pairs?: Record<string, Export>
  builtin?: boolean
}

export interface Prompt {
  task: string
  address: Record<string, string>
  glossary?: string
  earlier: string
  sentences: number
}

export interface SpeechModels {
  base: string
  asr: AsrChoice
  mt: MtChoice
  voices: Record<string, string>
  sizes: Record<string, number>
  prompt?: Prompt
}

export type AsrTier = 'primary' | 'fallback'

export function asrExport(asr: AsrChoice, tier: AsrTier, lang: string): Export | null {
  const choice = tier === 'primary' ? asr : asr.fallback
  if (!choice) return null
  return { model: choice.languages?.[lang] ?? choice.model, dtype: choice.dtype }
}

export type Sizes = Record<string, number>

export interface AsrRung extends Rung {
  model: string
  tier: AsrTier
}

export function hostedIn(sizes: Sizes, model: string): (dtype: string) => boolean {
  return (dtype) => Object.hasOwn(sizes, exportKey({ model, dtype }))
}

export function asrRungs(asr: AsrChoice, lang: string, capabilities: Capabilities, sizes: Sizes, floor: AsrTier): AsrRung[] {
  const tierRungs = (tier: AsrTier, cpu: boolean): AsrRung[] => {
    const wanted = asrExport(asr, tier, lang)
    if (!wanted) return []
    return rungsFor(wanted.dtype, capabilities, hostedIn(sizes, wanted.model), cpu).map((rung) => ({ ...rung, model: wanted.model, tier }))
  }
  return [...(floor === 'primary' ? tierRungs('primary', !asr.fallback) : []), ...tierRungs('fallback', true)]
}

export function loadsUpFront(mt: MtChoice): boolean {
  return mt.kind === 'llm' || Object.keys(mt.pairs ?? {}).length === 0
}

export function pairFor(mt: MtChoice, source: string, target: string): Export | null {
  return mt.pairs?.[`${source}-${target}`] ?? null
}

export function exportKey(wanted: Export): string {
  return `${wanted.model}:${wanted.dtype}`
}

export function voiceKey(voice: string): string {
  return `piper/${voice}`
}

export function bytesFor(models: SpeechModels, lang: string): number {
  const asr = asrExport(models.asr, 'primary', lang)
  const voice = models.voices[lang]
  const keys = [asr ? exportKey(asr) : undefined, loadsUpFront(models.mt) ? exportKey(models.mt) : undefined, voice === undefined ? undefined : voiceKey(voice)]
  return keys.reduce((total, key) => total + (key === undefined ? 0 : (models.sizes[key] ?? 0)), 0)
}

export function renderPrompt(prompt: Prompt, source: Language, target: Language, earlier: readonly string[]): string {
  const task = prompt.task.replaceAll('{source}', source.name).replaceAll('{target}', target.name)
  const context = earlier.length > 0 ? prompt.earlier + earlier.slice(-prompt.sentences).join(' ') : ''
  return task + (prompt.address[target.code] ?? '') + (prompt.glossary ?? '') + context
}

