// The browser speech engines on real models: a headless Chrome without a
// GPU loads the built workers and runs each on the models in
// SPEECH_MODEL_DIR, the directory scripts/fetch-speech-models.mjs fills.
//
//   SPEECH_MODEL_DIR=… node web/e2e/speech-engines.mjs
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { evalJs, findChrome, launchChrome, sleep, stopProcess } from './browser.mjs'
import { builtWorker, serveSpeechPage, workerProbe } from './speech-page.mjs'

const models = process.env.SPEECH_MODEL_DIR
if (!models) {
  console.error('SPEECH_MODEL_DIR is not set: point it at a directory fetch-speech-models.mjs filled')
  process.exit(2)
}

const chosen = JSON.parse(readFileSync(join(models, 'models.json'), 'utf8'))
const chrome = process.env.CHROME ?? findChrome()
const TIMEOUT_MS = 600_000
const dir = mkdtempSync(join(tmpdir(), 'speech-engines-'))
const failures = []

function check(label, condition, detail) {
  if (!condition) failures.push(`${label}: ${detail}`)
}

const SENTENCE = '1, 2, 3, 4, 5. 10, 20, 30.'

const ttsProbe = workerProbe(
  { tts: builtWorker('tts') },
  `
  const { ask } = workers.tts
  await ask({ type: 'init', base: '/speech/', voices: ${JSON.stringify(chosen.tts)} })
  const spoken = {}
  for (const lang of ${JSON.stringify(Object.keys(chosen.tts))}) {
    const times = []
    let seconds = 0
    try {
      for (let i = 0; i < 2; i++) {
        const started = performance.now()
        const reply = await ask({ type: 'speak', text: ${JSON.stringify(SENTENCE)}, lang, voice: 'female' })
        times.push(Math.round(performance.now() - started))
        seconds = reply.pcm.length / reply.rate
      }
      spoken[lang] = { seconds, times }
    } catch (err) {
      spoken[lang] = { error: String(err?.message ?? err) }
    }
  }
  return { spoken }
`,
)

const RECORDINGS = { en: '/fixtures/english.wav', de: '/fixtures/german.wav', sv: '/fixtures/swedish.wav' }
const SECONDS = 8

const asrProbe = workerProbe(
  { asr: builtWorker('asr') },
  `
  const { ask, events } = workers.asr
  const heard = {}
  for (const [lang, url] of Object.entries(${JSON.stringify(RECORDINGS)})) {
    const audio = (await readWav(url)).slice(0, ${SECONDS} * 16000)
    if (Object.keys(heard).length === 0) await ask({ type: 'init', base: '/speech/', asr: ${JSON.stringify(chosen.asr)}, lang })
    const started = performance.now()
    const { text } = await ask({ type: 'transcribe', audio, lang })
    heard[lang] = { text, ms: Math.round(performance.now() - started) }
  }
  return { heard, loading: events.filter((event) => event.event === 'loading').length }
`,
)

const pairs = Object.keys(chosen.mt.pairs ?? {})
const multilingual = ['de-da', 'da-de', 'en-da', 'de-en'].find((pair) => !pairs.includes(pair)) ?? 'de-en'
const TEXTS = { en: 'Good morning, shall we start with the budget?', de: 'Guten Morgen, sollen wir mit dem Budget anfangen?', da: 'Godmorgen, skal vi starte med budgettet?' }

const mtProbe = workerProbe(
  { mt: builtWorker('mt') },
  `
  const { ask } = workers.mt
  await ask({ type: 'init', base: '/speech/', mt: ${JSON.stringify(chosen.mt)} })
  const translated = {}
  for (const pair of ${JSON.stringify([...pairs.slice(0, 1), multilingual])}) {
    const [source, target] = pair.split('-')
    const started = performance.now()
    const { text } = await ask({ type: 'translate', text: ${JSON.stringify(TEXTS)}[source], source, target, system: '' })
    translated[pair] = { text, ms: Math.round(performance.now() - started) }
  }
  return { translated }
`,
)

async function probe(browser, label, expression) {
  const value = await Promise.race([evalJs(browser, expression), sleep(TIMEOUT_MS).then(() => ({ error: 'timed out' }))])
  console.log(`${label}: ${JSON.stringify(value)}`)
  check(label, value && !value.error, value?.error ?? 'no answer')
  return value ?? {}
}

async function main() {
  const server = await serveSpeechPage({ models })
  const browser = await launchChrome(chrome, 0, dir)
  try {
    await browser.cdp.send('Page.navigate', { url: `${server.origin}/` }, browser.sessionId)
    await sleep(1_000)

    const asr = await probe(browser, 'transcription', asrProbe)
    for (const [lang, { text }] of Object.entries(asr.heard ?? {})) {
      check(`transcription ${lang}`, typeof text === 'string' && text.trim().split(/\s+/).length >= 4, `heard ${JSON.stringify(text)}`)
    }
    check('transcription reports its download', asr.loading > 0 || process.env.CACHED === '1', 'no loading events')

    const mt = await probe(browser, 'translation', mtProbe)
    for (const [pair, { text }] of Object.entries(mt.translated ?? {})) {
      const source = TEXTS[pair.split('-')[0]]
      check(`translation ${pair}`, typeof text === 'string' && text.length > 10 && text !== source, `translated ${JSON.stringify(text)}`)
    }

    const tts = await probe(browser, 'voice', ttsProbe)
    for (const [lang, { seconds, error }] of Object.entries(tts.spoken ?? {})) {
      check(`voice ${lang}`, !error && seconds > 1, error ?? `spoke ${seconds} s`)
    }
  } finally {
    await stopProcess(browser.proc)
    server.close()
  }
}

let code = 0
try {
  await main()
} catch (err) {
  failures.push(`setup: ${err.message}`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
if (failures.length) {
  console.error('\nSPEECH ENGINES E2E FAILED')
  for (const failure of failures) console.error(`  - ${failure}`)
  code = 1
} else {
  console.log('\nSPEECH ENGINES E2E OK: the browser engines run on the real models')
}
process.exit(code)
