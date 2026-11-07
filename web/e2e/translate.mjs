#!/usr/bin/env node
// Live-translation end-to-end test: a server built with the race
// detector, its speech service on stand-in engines (SPEECH_ENGINES=fake:
// real voice detection, sessions and protocol; numbered "transcripts",
// "[lang] …" translations and a tone for a voice), and two headless
// Chromes whose microphones play an English and a German recording.
// The host turns translation on, each browser then translates its own
// speech, and the test checks what each side must get: the host's state
// reaching "live", subtitles in each listener's language on the other's
// tile (sent by that speaker), the translated voice arriving as audio,
// the other-language speaker muted under it, and translation outliving
// the host: after the host leaves, a joiner still gets the guest's
// speech in its own language.
//
// SPEECH_RUNTIME=browser runs the same test against the browsers' own
// engines, on the same stand-ins: no audio leaves either browser, the
// subtitles and the tone come from the code that runs the models.
//
// Needs Chrome (CHROME=…) and Go, which builds the server.
//
//   node web/e2e/translate.mjs

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { consoleOf, createRoom, evalJs, findChrome, freePort, joinRoom, launchChrome, sleep, stopProcess, waitFor } from './browser.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const chrome = process.env.CHROME ?? findChrome()
const runtime = process.env.SPEECH_RUNTIME === 'browser' ? 'browser' : 'server'
const TIMEOUT_MS = 45_000

const failures = []
const procs = []
const dir = mkdtempSync(join(tmpdir(), 'translate-e2e-'))

function check(label, condition, detail) {
  if (!condition) failures.push(`${label}: ${detail}`)
}

async function waitHealthy(url, what) {
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // not up yet
    }
    await sleep(200)
  }
  throw new Error(`${what} did not start on ${url}`)
}

function buildServer() {
  const bin = join(dir, 'server')
  const res = spawnSync('go', ['build', '-race', '-o', bin, './cmd/server'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: '1' },
  })
  if (res.status !== 0) throw new Error('go build ./cmd/server failed')
  return bin
}

async function startServer(bin) {
  const port = await freePort()
  procs.push(
    spawn(bin, [], {
      env: {
        ...process.env,
        PORT: String(port),
        BIND: '127.0.0.1',
        ICE_UDP_PORT: String(await freePort()),
        TURN_PORT: String(await freePort()),
        DB_PATH: join(dir, 'translate.db'),
        SPEECH_ENGINES: 'fake',
        SPEECH_RUNTIME: runtime,
        GORACE: 'halt_on_error=1',
      },
      stdio: 'inherit',
    }),
  )
  const base = `http://127.0.0.1:${port}`
  await waitHealthy(`${base}/api/config`, 'the meeting server')
  return base
}

// Language settings the app reads from localStorage on its first load.
function preset(browser, lang, name) {
  const prefs = JSON.stringify({ lang, voice: true, subtitles: true, voiceChoice: 'female' })
  return browser.cdp.send(
    'Page.addScriptToEvaluateOnNewDocument',
    {
      source: `localStorage.setItem('conference:translation', ${JSON.stringify(prefs)});
        localStorage.setItem('conference:name', ${JSON.stringify(JSON.stringify(name))})`,
    },
    browser.sessionId,
  )
}

// The tile whose name tag reads `name`, as [caption text, audio volume].
const tileState = (name) => `(() => {
  const tile = [...document.querySelectorAll('.hud-tile')].find((t) => t.innerText.toLowerCase().includes(${JSON.stringify(name.toLowerCase())}))
  if (!tile) return null
  return { caption: tile.querySelector('p.line-clamp-3')?.textContent ?? '', volume: tile.querySelector('audio')?.volume ?? null }
})()`

// Audio elements outside the tiles: the translated voice.
const translationAudio = `[...document.querySelectorAll('audio')]
  .filter((a) => !a.closest('.hud-tile'))
  .map((a) => ({ tracks: a.srcObject?.getAudioTracks().filter((t) => t.readyState === 'live').length ?? 0, paused: a.paused }))`

const consoles = {}

async function main() {
  const base = await startServer(buildServer())
  const room = await createRoom(base, 'translate-e2e')

  const fixtures = join(repoRoot, 'fixtures')
  const host = await launchChrome(chrome, 0, dir, [`--use-file-for-fake-audio-capture=${join(fixtures, 'english.wav')}`, '--mute-audio'])
  const guest = await launchChrome(chrome, 1, dir, [`--use-file-for-fake-audio-capture=${join(fixtures, 'german.wav')}`, '--mute-audio'])
  procs.push(host.proc, guest.proc)
  await preset(host, 'en', 'Hana')
  await preset(guest, 'de', 'Gerd')
  consoles.host = await consoleOf(host)
  consoles.guest = await consoleOf(guest)

  await joinRoom(host, room.privUrl)
  await joinRoom(guest, room.url)
  // Enabled once /api/config reports live translation can run.
  const button = await waitFor(
    host,
    `(() => {
      const button = document.querySelector('[aria-label="Start live translation"]')
      if (!button) return null
      return button.disabled ? 'disabled' : 'enabled'
    })()`,
    (state) => state === 'enabled',
    15_000,
  )
  check('start', button.ok, `no enabled "Start live translation" button for the host: ${JSON.stringify(button.value)}`)
  // One click: a second one would toggle translation off again.
  await evalJs(host, `document.querySelector('[aria-label="Start live translation"]')?.click()`)

  const live = await waitFor(host, `document.querySelector('header')?.innerText ?? ''`, (text) => text.includes('· live'), TIMEOUT_MS)
  check('host state', live.ok, `badge never reached "live": ${JSON.stringify(live.value)}`)

  const guestSees = await waitFor(guest, tileState('Hana'), (tile) => tile?.caption.startsWith('[de] en utterance'), TIMEOUT_MS)
  check('guest subtitles', guestSees.ok, `no German subtitle on the host's tile: ${JSON.stringify(guestSees.value)}`)

  const hostSees = await waitFor(host, tileState('Gerd'), (tile) => tile?.caption.startsWith('[en] de utterance'), TIMEOUT_MS)
  check('host subtitles', hostSees.ok, `no English subtitle on the guest's tile: ${JSON.stringify(hostSees.value)}`)

  const voice = await waitFor(guest, translationAudio, (list) => list?.some((a) => a.tracks > 0 && !a.paused), TIMEOUT_MS)
  const guestHeader = voice.ok ? '' : await evalJs(guest, `document.querySelector('header')?.innerText ?? ''`)
  check('guest voice', voice.ok, `no playing translated-voice track: ${JSON.stringify(voice.value)}; the guest's header reads ${JSON.stringify(guestHeader)}`)

  const muted = await waitFor(guest, tileState('Hana'), (tile) => tile?.volume === 0, 5_000)
  check('guest muting', muted.ok, `the host's own voice is not muted for the guest: ${JSON.stringify(muted.value)}`)

  // A guest who never chose a language starts in the browser's own one,
  // and the join screen asks for it plainly.
  const swede = await launchChrome(chrome, 3, dir, [`--use-file-for-fake-audio-capture=${join(fixtures, 'english.wav')}`, '--mute-audio', '--accept-lang=sv-SE,sv'])
  procs.push(swede.proc)
  await joinRoom(swede, room.url, null, async (browser) => {
    // The join screen keeps language and subtitles folded; open it like a guest would.
    const section = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Language and subtitles')`
    await waitFor(browser, `Boolean(${section})`, Boolean, 15_000)
    await evalJs(browser, `${section}?.click()`)
    const prompt = await waitFor(browser, `(() => {
      const label = [...document.querySelectorAll('label')].find((l) => l.textContent.includes('Which language do you speak?'))
      return label ? document.getElementById(label.htmlFor)?.textContent ?? '' : null
    })()`, (picked) => picked === 'Swedish', 15_000)
    check('browser language', prompt.ok, `the join screen did not start in the browser's language: ${JSON.stringify(prompt.value)}`)
  })
  await stopProcess(swede.proc)

  // The host leaves; translation stays on and a new English joiner gets
  // the guest's German speech in English from the guest's own browser.
  await stopProcess(host.proc)
  const late = await launchChrome(chrome, 2, dir, [`--use-file-for-fake-audio-capture=${join(fixtures, 'english.wav')}`, '--mute-audio'])
  procs.push(late.proc)
  await preset(late, 'en', 'Lena')
  await joinRoom(late, room.url)
  const lateSees = await waitFor(late, tileState('Gerd'), (tile) => tile?.caption.startsWith('[en] de utterance'), TIMEOUT_MS)
  check('after the host left', lateSees.ok, `a joiner got no English subtitle from the guest: ${JSON.stringify(lateSees.value)}`)

  console.log(`host state: ${JSON.stringify(live.value)}`)
  console.log(`guest sees: ${JSON.stringify(guestSees.value)}`)
  console.log(`host sees: ${JSON.stringify(hostSees.value)}`)
  console.log(`guest voice: ${JSON.stringify(voice.value)}`)
  console.log(`after the host left, joiner sees: ${JSON.stringify(lateSees.value)}`)
}

let code = 0
try {
  await main()
} catch (err) {
  failures.push(`setup: ${err.message}`)
} finally {
  for (const proc of procs.reverse()) await stopProcess(proc)
  rmSync(dir, { recursive: true, force: true })
}
if (failures.length) {
  for (const [name, lines] of Object.entries(consoles)) for (const line of lines) console.error(`${name} ${line}`)
  console.error('\nTRANSLATE E2E FAILED')
  for (const f of failures) console.error('  - ' + f)
  code = 1
} else {
  console.log(`runtime: ${runtime}`)
console.log(`\nTRANSLATE E2E OK (${runtime}): each side translates its own speech, and translation outlives the host`)
}
process.exit(code)
