import { errorMessage } from '../errors.ts'

interface BuiltinTranslator {
  translate(text: string): Promise<string>
}

interface Languages {
  sourceLanguage: string
  targetLanguage: string
}

interface TranslatorFactory {
  availability(languages: Languages): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>
  create(languages: Languages): Promise<BuiltinTranslator>
}

type Outcome =
  | { kind: 'ready'; translator: BuiltinTranslator }
  | { kind: 'refused'; warning: string; lasting: boolean }
  | { kind: 'absent' }

function factory(): TranslatorFactory | null {
  return (globalThis as { Translator?: TranslatorFactory }).Translator ?? null
}

export class BuiltinTranslators {
  private readonly pairs = new Map<string, Promise<Outcome>>()
  private readonly told = new Set<string>()
  private readonly failed = new Set<string>()
  private readonly onRefused: (warning: string) => void

  constructor(onRefused: (warning: string) => void) {
    this.onRefused = onRefused
  }

  async for(source: string, target: string): Promise<BuiltinTranslator | null> {
    const key = `${source}-${target}`
    const outcome = await this.outcome(key, source, target)
    if (outcome.kind === 'ready') return outcome.translator
    if (outcome.kind !== 'refused') return null
    if (!outcome.lasting) this.failed.add(key)
    if (!this.told.has(key)) {
      this.told.add(key)
      this.onRefused(outcome.warning)
    }
    return null
  }

  startPreparation(): void {
    this.told.clear()
    for (const key of this.failed) this.pairs.delete(key)
    this.failed.clear()
  }

  private outcome(key: string, source: string, target: string): Promise<Outcome> {
    const known = this.pairs.get(key)
    if (known) return known

    const pending = create(source, target)
    this.pairs.set(key, pending)
    return pending
  }
}

function refused(source: string, target: string, reason: string, lasting: boolean): Outcome {
  return { kind: 'refused', lasting, warning: `The browser's own translator cannot translate ${source} into ${target} (${reason}), so those sentences use the downloaded model.` }
}

async function create(sourceLanguage: string, targetLanguage: string): Promise<Outcome> {
  const translators = factory()
  if (!translators) return { kind: 'absent' }

  try {
    if ((await translators.availability({ sourceLanguage, targetLanguage })) === 'unavailable') {
      return refused(sourceLanguage, targetLanguage, 'the browser reports this pair as unavailable', true)
    }
    return { kind: 'ready', translator: await translators.create({ sourceLanguage, targetLanguage }) }
  } catch (err) {
    return refused(sourceLanguage, targetLanguage, errorMessage(err), false)
  }
}
