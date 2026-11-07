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

const SENTENCES = {
  en: 'Good morning, everyone. Shall we start with the budget?',
  de: 'Guten Morgen zusammen. Sollen wir mit dem Budget anfangen?',
  da: 'Godmorgen allesammen. Skal vi starte med budgettet?',
}

const voiced = Object.keys(chosen.tts).filter((lang) => SENTENCES[lang])

const ttsProbe = workerProbe(
  { tts: builtWorker('tts') },
  `
  const { ask } = workers.tts
  await ask({ type: 'init', base: '/speech/', voices: ${JSON.stringify(chosen.tts)} })
  const spoken = {}
  for (const [lang, text] of Object.entries(${JSON.stringify(Object.fromEntries(voiced.map((lang) => [lang, SENTENCES[lang]])))})) {
    const times = []
    let seconds = 0
    for (let i = 0; i < 3; i++) {
      const started = performance.now()
      const reply = await ask({ type: 'speak', text, lang, voice: 'female' })
      times.push(Math.round(performance.now() - started))
      seconds = reply.pcm.length / reply.rate
    }
    spoken[lang] = { seconds, times }
  }
  return { spoken }
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

    const tts = await probe(browser, 'voice', ttsProbe)
    for (const [lang, { seconds, times }] of Object.entries(tts.spoken ?? {})) {
      check(`voice ${lang}`, seconds > 1, `spoke ${seconds} s`)
      check(`voice ${lang} again`, times[2] < times[0], `the third sentence took ${times[2]} ms, the first ${times[0]} ms`)
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
