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

function factory(): TranslatorFactory | null {
  return (globalThis as { Translator?: TranslatorFactory }).Translator ?? null
}

export class BuiltinTranslators {
  private readonly pairs = new Map<string, Promise<BuiltinTranslator | null>>()

  for(source: string, target: string): Promise<BuiltinTranslator | null> {
    const key = `${source}-${target}`
    const known = this.pairs.get(key)
    if (known) return known

    const pending = create(source, target)
    this.pairs.set(key, pending)
    return pending
  }
}

async function create(sourceLanguage: string, targetLanguage: string): Promise<BuiltinTranslator | null> {
  const translators = factory()
  if (!translators) return null

  try {
    if ((await translators.availability({ sourceLanguage, targetLanguage })) === 'unavailable') return null
    return await translators.create({ sourceLanguage, targetLanguage })
  } catch (err) {
    console.warn(`the browser's own translator cannot translate ${sourceLanguage} into ${targetLanguage}:`, err)
    return null
  }
}
