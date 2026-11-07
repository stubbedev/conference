import type { Language } from '../translate/languages.ts'

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

export type MtKind = 'seq2seq' | 'llm'

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

export function pairFor(mt: MtChoice, source: string, target: string): Export | null {
  return mt.pairs?.[`${source}-${target}`] ?? null
}

export function voiceKey(voice: string): string {
  return `piper/${voice}`
}

export function bytesFor(models: SpeechModels, lang: string): number {
  const asr = asrExport(models.asr, 'primary', lang)
  const voice = models.voices[lang]
  const keys = [asr?.model, models.mt.model, voice === undefined ? undefined : voiceKey(voice)]
  return keys.reduce((total, key) => total + (key === undefined ? 0 : (models.sizes[key] ?? 0)), 0)
}

export function renderPrompt(prompt: Prompt, source: Language, target: Language, earlier: readonly string[]): string {
  const task = prompt.task.replaceAll('{source}', source.name).replaceAll('{target}', target.name)
  const context = earlier.length > 0 ? prompt.earlier + earlier.slice(-prompt.sentences).join(' ') : ''
  return task + (prompt.address[target.code] ?? '') + (prompt.glossary ?? '') + context
}

