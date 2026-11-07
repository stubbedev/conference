// What a member's browser loads when the browsers run the speech engines:
// the models this server serves, chosen by whoever runs it. The shape
// matches internal/speech/service's Models in /api/config.

import type { TranslationConfig } from '@/lib/api'

/** One purpose's model, as transformers.js names it. */
export interface ModelChoice {
  /** The model's directory under the base path, owner and name. */
  model: string
  /** The ONNX export to load, e.g. q4f16 or q8. */
  dtype: string
  /** The languages that load a model of their own instead, e.g. a Danish fine-tune. */
  languages?: Record<string, string>
}

/** What this server serves for the browsers. */
export interface SpeechModels {
  /** Where the files are served; transformers.js resolves model ids under it. */
  base: string
  asr: ModelChoice
  mt: ModelChoice
  /** The Piper voice each language speaks in, named as Piper names them. */
  voices: Record<string, string>
}

/** The voice a language speaks in, when the server has one for it. */
export function voiceFor(models: SpeechModels, lang: string): string | null {
  return models.voices[lang] ?? null
}

/** The models to load, or null when live translation is not in the browser. */
export function speechModels(config: TranslationConfig): SpeechModels | null {
  if (config.mode !== 'browser' || !config.models) return null
  return config.models
}
