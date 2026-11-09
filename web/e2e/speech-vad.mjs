// Speech-engine end-to-end test, without a model download: the built web
// UI is served as the server serves it, a headless Chrome loads the voice
// detection worker from it, and the worker must run the Silero model on
// the ONNX Runtime files the build vendored. That is the plumbing every
// browser engine shares: the WebAssembly runtime from /ort/, a model at an
// absolute path, a worker that answers requests, and a session with no GPU.
//
// The audio is fixtures/english.wav, the same recording the speech
// service's own tests segment: a model that runs but sees nothing is not a
// working pipeline, so the test checks that real speech is found too.
//
// Needs Chrome (CHROME=…) and a built UI (`cd web && npm run build`).
//
//   node web/e2e/speech-vad.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { evalJs, findChrome, launchChrome, sleep, stopProcess } from './browser.mjs'
import { builtWorker, serveSpeechPage, workerProbe } from './speech-page.mjs'

const chrome = process.env.CHROME ?? findChrome()
const TIMEOUT_MS = 120_000
const FRAME = 512
const dir = mkdtempSync(join(tmpdir(), 'speech-vad-'))

const failures = []

function check(label, condition, detail) {
  if (!condition) failures.push(`${label}: ${detail}`)
}

const probe = workerProbe(
  { vad: builtWorker('vad') },
  `
  const { ask } = workers.vad
  await ask({ type: 'init', base: '/vad/', runtime: await fetchRuntime() })
  const samples = await readWav('/fixtures/english.wav')
  let speech = 0
  for (let i = 0; i < 400 * ${FRAME}; i += ${FRAME}) {
    const { probability } = await ask({ type: 'detect', frame: samples.slice(i, i + ${FRAME}) })
    speech = Math.max(speech, probability)
  }
  const silent = await ask({ type: 'detect', frame: new Int16Array(${FRAME}) })
  return { speech, silence: silent.probability, isolated: crossOriginIsolated }
`,
)

async function main() {
  const server = await serveSpeechPage()
  const browser = await launchChrome(chrome, 0, dir)
  try {
    await browser.cdp.send('Page.navigate', { url: `${server.origin}/` }, browser.sessionId)
    await sleep(1_000)

    const value = await Promise.race([evalJs(browser, probe), sleep(TIMEOUT_MS).then(() => ({ timedOut: true }))])

    check('voice detection', typeof value?.speech === 'number', `the worker never answered: ${JSON.stringify(value)}`)
    if (typeof value?.speech === 'number') {
      check('speech is found', value.speech > 0.5, `highest probability ${value.speech}`)
      check('the page is cross-origin isolated', value.isolated === true, 'the worker runs on one thread')
      check('silence is not', value.silence < 0.2, `probability ${value.silence}`)
    }

    console.log(`voice detection: ${JSON.stringify(value)}`)
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
  console.error('\nSPEECH E2E FAILED')
  for (const failure of failures) console.error(`  - ${failure}`)
  code = 1
} else {
  console.log('\nSPEECH E2E OK: voice detection runs in the browser on the vendored runtime')
}
process.exit(code)
