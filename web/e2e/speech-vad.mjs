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
import { createReadStream, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { evalJs, findChrome, launchChrome, sleep, stopProcess } from './browser.mjs'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = resolve(web, 'dist', 'app')
const fixtures = resolve(web, '..', 'fixtures')
const chrome = process.env.CHROME ?? findChrome()
const TIMEOUT_MS = 120_000
const dir = mkdtempSync(join(tmpdir(), 'speech-vad-'))

const CONTENT_TYPES = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.json': 'application/json',
  '.html': 'text/html',
}

const failures = []

function check(label, condition, detail) {
  if (!condition) failures.push(`${label}: ${detail}`)
}

/** The worker the app builds, whose file name the bundler hashes. */
function vadWorker() {
  const assets = join(appRoot, 'assets')
  const name = readdirSync(assets).find((file) => file.startsWith('vad.worker-') && file.endsWith('.js'))
  if (!name) throw new Error(`no vad worker in ${assets}; run npm run build in web/ first`)
  return `/assets/${name}`
}

/** Serves the built UI as the server does, and the fixture recordings beside it. */
function serve() {
  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      const path = decodeURIComponent((req.url ?? '/').split('?')[0])
      const file = path.startsWith('/fixtures/') ? join(fixtures, path.slice('/fixtures/'.length)) : join(appRoot, path)
      const root = path.startsWith('/fixtures/') ? fixtures : appRoot

      if (!file.startsWith(root)) {
        res.writeHead(403).end()
        return
      }

      let target = file
      try {
        if (statSync(target).isDirectory()) target = join(target, 'index.html')
      } catch {
        res.writeHead(404).end()
        return
      }

      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      })
      createReadStream(target).pipe(res)
    })

    server.listen(0, '127.0.0.1', () => resolveServer(server))
  })
}

/** Reads the sample frames of a 16 kHz mono PCM WAV file. */
const wav = `async (url) => {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
  const view = new DataView(bytes.buffer)
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4))
    const length = view.getUint32(offset + 4, true)
    if (id === 'data') {
      const samples = new Int16Array(bytes.buffer, offset + 8, length / 2)
      const frames = []
      for (let i = 0; i + 512 <= samples.length; i += 512) frames.push(samples.slice(i, i + 512))
      return frames
    }
    offset += 8 + length + (length % 2)
  }
  throw new Error('no data chunk in ' + url)
}`

// Runs the worker over the recording and over silence, and reports the
// highest probability each reached.
const probe = (worker) => `(async () => {
  const voice = new Worker(${JSON.stringify(worker)}, { type: 'module' })
  const queue = new Map()
  voice.onmessage = (event) => {
    const waiter = queue.get(event.data.id)
    if (!waiter) return
    queue.delete(event.data.id)
    if (event.data.type === 'error') waiter.reject(new Error(event.data.message))
    else waiter.resolve(event.data)
  }
  const ask = (message) => new Promise((resolve, reject) => {
    const id = Math.random()
    queue.set(id, { resolve, reject })
    voice.postMessage({ ...message, id })
  })
  const read = ${wav}
  try {
    await ask({ type: 'init', base: '/vad/' })
    const frames = await read('/fixtures/english.wav')
    let speech = 0
    for (const frame of frames.slice(0, 400)) {
      const { probability } = await ask({ type: 'detect', frame })
      speech = Math.max(speech, probability)
    }
    const silent = await ask({ type: 'detect', frame: new Int16Array(512) })
    return { speech, silence: silent.probability, frames: frames.length, isolated: crossOriginIsolated }
  } catch (err) {
    return { error: String(err?.message ?? err) }
  } finally {
    voice.terminate()
  }
})()`

async function main() {
  const server = await serve()
  const origin = `http://127.0.0.1:${server.address().port}`

  const browser = await launchChrome(chrome, 0, dir)
  try {
    await browser.cdp.send('Page.navigate', { url: `${origin}/` }, browser.sessionId)
    await sleep(1_000)

    const value = await Promise.race([
      evalJs(browser, probe(vadWorker())),
      sleep(TIMEOUT_MS).then(() => ({ timedOut: true })),
    ])

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
