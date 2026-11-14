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
// the other-language speaker muted under it, that speaker's own voice
// coming back once its translator has given up while translation stays
// on, and translation outliving the host: after the host leaves, a
// joiner still gets the guest's speech in its own language.
//
// A translated voice that stays in the call with nothing to say must
// give way as well. Against the speech service the test takes the voice
// of the host's sentences away, drops the host's connection once, and
// at the end lets the guest's connection open and drop until the guest
// gives up: each time the listener has to hear the speaker's own voice,
// and the translated one again when it is back.
//
// SPEECH_RUNTIME=browser runs the same test against the browsers' own
// engines, on the same stand-ins: no audio leaves either browser, the
// subtitles and the tone come from the code that runs the models. There
// the test breaks the host's transcription and mends it again, and lets
// a third member join whose language already has a translator, to see
// that member named under the caption.
//
// Needs Chrome (CHROME=…) and Go, which builds the server.
//
//   node web/e2e/translate.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { consoleOf, createRoom, evalJs, findChrome, joinRoom, launchChrome, sleep, stopProcess, waitFor } from './browser.mjs'
import { buildServer, repoRoot, serverEnv, startServer } from './server.mjs'

const chrome = process.env.CHROME ?? findChrome()
const runtime = process.env.SPEECH_RUNTIME === 'browser' ? 'browser' : 'server'
const TIMEOUT_MS = 45_000

const failures = []
const procs = []
const dir = mkdtempSync(join(tmpdir(), 'translate-e2e-'))

function check(label, condition, detail) {
  if (!condition) failures.push(`${label}: ${detail}`)
}

async function startMeetingServer() {
  const env = serverEnv(dir, {
    BIND: '127.0.0.1',
    SPEECH_ENGINES: 'fake',
    SPEECH_RUNTIME: runtime,
    // On the server the stand-in voice engine clones too: a higher tone in the speaker's own voice.
    ...(runtime === 'server' ? { VOICE_CLONING: 'true' } : {}),
  })
  const server = await startServer(buildServer(dir, { race: true }), env)
  procs.push(server.proc)
  server.proc.stdout.pipe(process.stdout)
  server.proc.stderr.pipe(process.stderr)
  return server.base
}

// Language settings the app reads from localStorage on its first load.
function preset(browser, lang, name, voiceChoice = 'female') {
  const prefs = JSON.stringify({ lang, voice: true, subtitles: true, voiceChoice })
  return browser.cdp.send(
    'Page.addScriptToEvaluateOnNewDocument',
    {
      source: `localStorage.setItem('conference:translation', ${JSON.stringify(prefs)});
        localStorage.setItem('conference:name', ${JSON.stringify(JSON.stringify(name))})`,
    },
    browser.sessionId,
  )
}

// The tile whose name tag reads `name`: its caption, who is named under
// it as the translator, and the volume of the member's own voice.
const tileState = (name) => `(() => {
  const named = (tile) => tile.querySelector('.hud-label')?.innerText.toLowerCase().includes(${JSON.stringify(name.toLowerCase())})
  const tile = [...document.querySelectorAll('.hud-tile')].find(named)
  if (!tile) return null
  return {
    caption: tile.querySelector('p.line-clamp-3')?.textContent ?? '',
    by: tile.querySelector('.hud-caption p + p')?.textContent ?? '',
    volume: tile.querySelector('audio')?.volume ?? null,
    label: tile.querySelector('.hud-label')?.textContent ?? '',
  }
})()`

// Audio elements outside the tiles: the translated voice.
const translationAudio = `[...document.querySelectorAll('audio')]
  .filter((a) => !a.closest('.hud-tile'))
  .map((a) => ({ tracks: a.srcObject?.getAudioTracks().filter((t) => t.readyState === 'live').length ?? 0, paused: a.paused }))`

// What the listener hears of the member named `name`: the volume of their
// own voice and the translated voices playing in its place.
const heardOf = (name) => `({ own: ${tileState(name)}?.volume ?? null, translated: ${translationAudio} })`

const hearsOwn = (heard) => heard?.own > 0 && heard.translated.length === 0
const hearsTranslation = (heard) => heard?.own === 0 && heard.translated.some((a) => a.tracks > 0 && !a.paused)

const header = `document.querySelector('header')?.innerText ?? ''`

const closeSpeechSockets = `for (const socket of window.__sockets) if (socket.url.includes('/ws/speech')) socket.close()`

const dropSpeechConnection = `(() => {
  ${closeSpeechSockets}
})()`

// Opens every later connection to the speech service through open, a
// function of the page's WebSocket and the address, and drops the one
// that is open.
const speechSockets = (open) => `(() => {
  const Open = window.WebSocket
  const open = ${open}
  window.WebSocket = function (url, ...rest) {
    return String(url).includes('/ws/speech') ? open(Open, String(url)) : new Open(url, ...rest)
  }
  window.WebSocket.prototype = Open.prototype
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
  ${closeSpeechSockets}
})()`

// Turns every later connection away, as a speech service that is gone
// for good would.
const loseSpeechService = speechSockets(`(Open, url) => new Open(url.replace('/ws/speech', '/ws/speech-gone'))`)

// Lets every later connection open and drops it straight away, as a
// speech service that accepts a member and then fails would.
const flapSpeechService = speechSockets(`(Open, url) => {
  const socket = new Open(url)
  socket.addEventListener('open', () => setTimeout(() => socket.close(), 300))
  return socket
}`)

// Takes the voice of every sentence away while window.__voiceless is
// set: a frame of voice from the speech service reaches the page as the
// notice the service sends when its voice engine fails for a sentence.
const loseVoices = `(() => {
  window.__voiceless = true
  for (const socket of window.__sockets) {
    if (!socket.url.includes('/ws/speech') || socket.readyState !== WebSocket.OPEN) continue
    const deliver = socket.onmessage
    socket.onmessage = (event) => {
      if (!window.__voiceless || typeof event.data === 'string') return deliver.call(socket, event)
      const header = JSON.parse(new TextDecoder().decode(new Uint8Array(event.data, 2, new DataView(event.data).getUint16(0))))
      const notice = { type: 'notice', code: 'voice-failed', lang: header.lang }
      deliver.call(socket, new MessageEvent('message', { data: JSON.stringify(notice) }))
    }
  }
})()`
const findVoices = `(() => { window.__voiceless = false })()`

// Breaks what the browser's transcriber needs to tell speech from
// invented text, so every transcription fails as it would with a model
// that crashed, and puts it back.
const breakTranscription = `(() => {
  window.__CompressionStream = window.CompressionStream
  window.CompressionStream = class {
    constructor() {
      throw new Error('the transcriber broke')
    }
  }
})()`
const mendTranscription = `(() => { window.CompressionStream = window.__CompressionStream })()`

const consoles = {}

// The guest records its voice on the join screen, so it is in use from its first sentence.
async function recordOwnVoice(browser) {
  // Language and subtitles are folded on the join screen; open them like a person would.
  const section = `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Language and subtitles')`
  await waitFor(browser, `Boolean(${section})`, Boolean, 15_000)
  await evalJs(browser, `${section}?.click()`)
  // Without the speaker's consent to the server making their voice, recording stays off.
  const recordState = `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Record my voice'))?.disabled`
  const blocked = await waitFor(browser, recordState, (disabled) => disabled === true, 15_000)
  check('server consent', blocked.ok, `recording was possible without consenting to the server: ${JSON.stringify(blocked.value)}`)
  await evalJs(browser, `document.getElementById('server-voice')?.click()`)
  const recordButton = `[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Record my voice') && !b.disabled)`
  await waitFor(browser, `Boolean(${recordButton})`, Boolean, 15_000)
  await evalJs(browser, `${recordButton}?.click()`)
  const recorded = await waitFor(browser, `document.body.innerText`, (text) => text.includes('Your voice is recorded'), 30_000)
  check('recorded voice', recorded.ok, 'the guest could not record its voice on the join screen')
}

async function main() {
  const base = await startMeetingServer()
  const room = await createRoom(base, 'translate-e2e')

  const fixtures = join(repoRoot, 'fixtures')
  const host = await launchChrome(chrome, 0, dir, [`--use-file-for-fake-audio-capture=${join(fixtures, 'english.wav')}`, '--mute-audio'])
  const guest = await launchChrome(chrome, 1, dir, [`--use-file-for-fake-audio-capture=${join(fixtures, 'german.wav')}`, '--mute-audio'])
  procs.push(host.proc, guest.proc)
  await preset(host, 'en', 'Hana')
  // On the server, the guest speaks in its own voice, recorded before joining.
  const ownVoice = runtime === 'server'
  await preset(guest, 'de', 'Gerd', ownVoice ? 'own' : 'female')
  consoles.host = await consoleOf(host)
  consoles.guest = await consoleOf(guest)

  await joinRoom(host, room.privUrl)
  await joinRoom(guest, room.url, null, ownVoice ? recordOwnVoice : null)
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

  const live = await waitFor(host, header, (text) => text.includes('· live'), TIMEOUT_MS)
  check('host state', live.ok, `badge never reached "live": ${JSON.stringify(live.value)}`)

  const guestSees = await waitFor(guest, tileState('Hana'), (tile) => tile?.caption.startsWith('[de] en utterance'), TIMEOUT_MS)
  check('guest subtitles', guestSees.ok, `no German subtitle on the host's tile: ${JSON.stringify(guestSees.value)}`)
  // The speaker's own bridge, or the guest's own engines, translated it.
  check('no translator to name', guestSees.value?.by === '', `a translator is named under a caption no other member translated: ${JSON.stringify(guestSees.value)}`)

  const hostSees = await waitFor(host, tileState('Gerd'), (tile) => tile?.caption.startsWith('[en] de utterance'), TIMEOUT_MS)
  check('host subtitles', hostSees.ok, `no English subtitle on the guest's tile: ${JSON.stringify(hostSees.value)}`)

  const voice = await waitFor(guest, translationAudio, (list) => list?.some((a) => a.tracks > 0 && !a.paused), TIMEOUT_MS)
  const guestHeader = voice.ok ? '' : await evalJs(guest, header)
  check('guest voice', voice.ok, `no playing translated-voice track: ${JSON.stringify(voice.value)}; the guest's header reads ${JSON.stringify(guestHeader)}`)

  if (ownVoice) {
    const inUse = await waitFor(guest, `document.querySelector('header')?.innerText ?? ''`, (text) => text.includes('Your own voice is in use'), TIMEOUT_MS)
    check('own voice', inUse.ok, `the guest's recorded voice was never in use: ${JSON.stringify(inUse.value)}`)
    const labelled = await waitFor(host, tileState('Gerd'), (tile) => tile?.label.includes('AI voice (cloned)'), TIMEOUT_MS)
    check('cloned voice', labelled.ok, `the host's tile for the guest never said "AI voice (cloned)": ${JSON.stringify(labelled.value)}`)
  }

  const muted = await waitFor(guest, tileState('Hana'), (tile) => tile?.volume === 0, 5_000)
  check('guest muting', muted.ok, `the host's own voice is not muted for the guest: ${JSON.stringify(muted.value)}`)

  // The host's translator gives up while live translation stays on in the
  // room: its translated voice leaves the call, and the guest must hear
  // the host's own voice again instead of nothing. Only the speech
  // service's voices travel as tracks; the browsers' own engines make
  // theirs where they are heard.
  if (runtime === 'server') {
    // A sentence the speech service captions but cannot voice: the
    // translated voice stays published, and the guest must hear the
    // host's own voice until a sentence has a voice again.
    await evalJs(host, loseVoices)
    const unvoiced = await waitFor(guest, heardOf('Hana'), hearsOwn, TIMEOUT_MS)
    check('sentence without a voice', unvoiced.ok, `the guest does not hear the host's own voice while the host's sentences get no voice: ${JSON.stringify(unvoiced.value)}`)
    const stillLive = await evalJs(host, header)
    check('translator alive', stillLive.includes('· live') && !stillLive.includes('failed'), `the host's translator did not stay live without its voice: ${JSON.stringify(stillLive)}`)
    const shown = (await evalJs(guest, tileState('Hana')))?.caption ?? ''
    const captioned = await waitFor(
      guest,
      `({ tile: ${tileState('Hana')}, heard: ${heardOf('Hana')} })`,
      (state) => state.tile?.caption.startsWith('[de] en utterance') && state.tile.caption !== shown && hearsOwn(state.heard),
      TIMEOUT_MS,
    )
    check('captions without a voice', captioned.ok, `no new German subtitle while the host's sentences get no voice: ${JSON.stringify(captioned.value)}`)
    await evalJs(host, findVoices)
    const voicedAgain = await waitFor(guest, heardOf('Hana'), hearsTranslation, TIMEOUT_MS)
    check('voice again', voicedAgain.ok, `the guest does not hear the translated voice once the host's sentences have one again: ${JSON.stringify(voicedAgain.value)}`)

    // The host's speech connection drops once: until it is back, nothing
    // feeds the translated voice, and the guest must hear the host's own.
    await evalJs(host, dropSpeechConnection)
    const dropped = await waitFor(guest, heardOf('Hana'), hearsOwn, 15_000)
    check('dropped connection', dropped.ok, `the guest does not hear the host's own voice while the host's speech connection is down: ${JSON.stringify(dropped.value)}`)
    const reconnected = await waitFor(host, header, (text) => text.includes('· live'), TIMEOUT_MS)
    check('reconnected', reconnected.ok && !reconnected.value.includes('failed'), `the host's translator did not reconnect: ${JSON.stringify(reconnected.value)}`)
    const resumed = await waitFor(guest, heardOf('Hana'), hearsTranslation, TIMEOUT_MS)
    check('voice after reconnecting', resumed.ok, `the guest does not hear the translated voice after the host reconnected: ${JSON.stringify(resumed.value)}`)

    await evalJs(host, loseSpeechService)
    const gaveUp = await waitFor(host, header, (text) => text.includes('Live translation failed'), TIMEOUT_MS)
    check('host gives up', gaveUp.ok, `the host's translator never reported failing: ${JSON.stringify(gaveUp.value)}`)

    const ownAgain = await waitFor(guest, heardOf('Hana'), hearsOwn, TIMEOUT_MS)
    check('own voice again', ownAgain.ok, `the guest does not hear the host's own voice after the host's translator stopped: ${JSON.stringify(ownAgain.value)}`)
    console.log(`after the host's translator stopped, guest hears: ${JSON.stringify(ownAgain.value)}`)
  } else {
    // A second English speaker joins: one of the two translates the
    // guest's German for both, and the other is shown who did.
    const emil = await launchChrome(chrome, 4, dir, [`--use-file-for-fake-audio-capture=${join(fixtures, 'english.wav')}`, '--mute-audio'])
    procs.push(emil.proc)
    await preset(emil, 'en', 'Emil')
    await joinRoom(emil, room.url)
    const readers = { Hana: host, Emil: emil }
    let named = null
    for (let waited = 0; waited < TIMEOUT_MS && !named; waited += 500) {
      for (const [reader, browser] of Object.entries(readers)) {
        const tile = await evalJs(browser, tileState('Gerd'))
        if (tile?.by) named = { reader, ...tile }
      }
      if (!named) await sleep(500)
    }
    const translator = named?.reader === 'Hana' ? 'Emil' : 'Hana'
    check(
      'translator named',
      named?.by === `Translated by ${translator}` && named.caption.startsWith('[en] de utterance'),
      `neither English speaker is shown that the other translated the guest: ${JSON.stringify(named)}`,
    )
    console.log(`a caption another member translated: ${JSON.stringify(named)}`)
    await stopProcess(emil.proc)

    // The host's transcription breaks mid-call. The voice the guest's
    // own engines made of the host has nothing more to say, so the guest
    // must hear the host's own voice, and the translation again once the
    // host is transcribed again.
    const translated = await waitFor(guest, heardOf('Hana'), hearsTranslation, TIMEOUT_MS)
    check('voice before the break', translated.ok, `the guest does not hear the host translated before the host's transcription breaks: ${JSON.stringify(translated.value)}`)
    await evalJs(host, breakTranscription)
    const uncaptioned = await waitFor(guest, heardOf('Hana'), hearsOwn, TIMEOUT_MS)
    check('captions stopped', uncaptioned.ok, `the guest does not hear the host's own voice after the host's transcription broke: ${JSON.stringify(uncaptioned.value)}`)
    await evalJs(host, mendTranscription)
    const recaptioned = await waitFor(guest, heardOf('Hana'), hearsTranslation, TIMEOUT_MS)
    check('captions back', recaptioned.ok, `the guest does not hear the host translated once the host is transcribed again: ${JSON.stringify(recaptioned.value)}`)
    console.log(`while the host's transcription was broken, guest hears: ${JSON.stringify(uncaptioned.value)}`)
  }

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

  // The guest's speech connection opens and drops, over and over. The
  // guest must give up on it, and the joiner hear the guest's own voice.
  if (runtime === 'server') {
    const lateHears = await waitFor(late, heardOf('Gerd'), hearsTranslation, TIMEOUT_MS)
    check('joiner voice', lateHears.ok, `the joiner does not hear the guest translated: ${JSON.stringify(lateHears.value)}`)
    await evalJs(guest, flapSpeechService)
    const flapped = await waitFor(guest, header, (text) => text.includes('Live translation failed'), TIMEOUT_MS)
    check('dropping connection given up', flapped.ok && flapped.value.includes('keeps dropping'), `the guest never gave up on a speech connection that keeps dropping: ${JSON.stringify(flapped.value)}`)
    const lateOwn = await waitFor(late, heardOf('Gerd'), hearsOwn, TIMEOUT_MS)
    check('own voice of a given-up speaker', lateOwn.ok, `the joiner does not hear the guest's own voice after the guest gave up: ${JSON.stringify(lateOwn.value)}`)
    console.log(`after the guest gave up on a dropping connection, joiner hears: ${JSON.stringify(lateOwn.value)}`)
  }

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
