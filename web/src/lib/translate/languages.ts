// Languages for live translation. The list itself comes from the speech
// service (speech/languages.yaml, via /api/config), so adding a language
// is a change there only.

export interface Language {
  code: string
  name: string
}

export const DEFAULT_LANGUAGE = 'en'

export function languageName(languages: readonly Language[], code: string): string {
  return languages.find((language) => language.code === code)?.name ?? code
}
