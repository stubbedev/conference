#!/usr/bin/env node
// Live-translation demo on one machine: you join as the host in a Chrome
// window with your real camera and mic, speaking English; a second
// window joins as a guest, German by default (`sv` for Swedish), whose
// "mic" plays a recording from fixtures/. Live translation starts on its
// own, so you read and hear the guest in English, and the guest's window
// shows subtitles of what you say in their language.
//
// With `hear`, the guest stays silent and their window plays sound, so
// you hear yourself translated. Wear headphones: the guest's window is a
// separate Chrome, so your mic would pick up its German otherwise.
//
// `male` or `female` (the default) picks the voice others hear you in.
// `openai` has OpenAI transcribe, translate and speak, with the key from
// speech/.env. Testing only: audio and text leave our hardware. Without
// it, your own engines do: Ollama (TRANSLATE_URL; Gemma unless
// TRANSLATE_MODEL), a transcription server (TRANSCRIBE_URL, e.g.
// whisper.cpp's whisper-server) and a voice server (VOICE_URL, VOICE_MODEL,
// VOICE_NAME), from the environment or speech/.env.
//
//   TRANSLATE_URL=… TRANSCRIBE_URL=… VOICE_URL=… VOICE_MODEL=… VOICE_NAME=… \
//     just translate-demo [hear] [de|sv] [male|female]
//   just translate-demo openai [hear] [de|sv] [male|female]
//
// Ctrl+C stops everything this script started.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createRoom, evalJs, findChrome, joinRoom, launchChrome, sleep } from './browser.mjs'
import { buildServer, ensureSpeech, repoRoot, shutdown, SPEECH_PORT, startServer, track } from './translate-stack.mjs'

const chrome = process.env.CHROME ?? findChrome()
const secret = process.env.SPEECH_SECRET ?? 'translate-demo'
const hear = process.argv.includes('hear')
const openai = process.argv.includes('openai')
const GUESTS = {
  de: { name: 'Anna (German)', recording: 'german.wav' },
  sv: { name: 'Astrid (Swedish)', recording: 'swedish.wav' },
}
const guestLang = process.argv.find((arg) => arg in GUESTS) ?? 'de'
const guestInfo = GUESTS[guestLang]
const yourVoice = process.argv.includes('male') ? 'male' : 'female'

const dir = mkdtempSync(join(tmpdir(), 'translate-demo-'))
track({ close: () => rmSync(dir, { recursive: true, force: true }) })

// Settings the app reads from localStorage, set before its first load.
function presetMember(browser, lang, name, voiceChoice) {
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

// Chrome's fake mic beeps unless it plays a file: a silent one keeps the
// guest quiet in `hear` mode.
function silentWav() {
  const seconds = 5
  const rate = 16_000
  const data = rate * seconds * 2
  const wav = Buffer.alloc(44 + data)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + data, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(rate, 24)
  wav.writeUInt32LE(rate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(data, 40)
  const path = join(dir, 'silence.wav')
  writeFileSync(path, wav)
  return path
}

async function main() {
  await ensureSpeech({ dir, secret, openai })
  const base = await startServer(buildServer(dir), dir, {
    speechURL: `ws://127.0.0.1:${SPEECH_PORT}/v1/stream`,
    secret,
  })
  const room = await createRoom(base, 'Live translation demo')

  // You: real camera and mic. The guest: a recording, muted so its
  // speakers do not feed your mic; in `hear` mode silent instead, with
  // sound on, so you hear yourself translated.
  const you = await launchChrome(chrome, 0, dir, ['--window-position=40,40'], { headless: false, fakeDevices: false })
  track(you.proc)
  const guestArgs = hear
    ? [`--use-file-for-fake-audio-capture=${silentWav()}`]
    : [`--use-file-for-fake-audio-capture=${join(repoRoot, 'fixtures', guestInfo.recording)}`, '--mute-audio']
  const guest = await launchChrome(chrome, 1, dir, [...guestArgs, '--window-position=640,140'], {
    headless: false,
  })
  track(guest.proc)

  await presetMember(you, 'en', 'You', yourVoice)
  await presetMember(guest, guestLang, guestInfo.name, 'female')
  await joinRoom(you, room.privUrl)
  await joinRoom(guest, room.url)
  await sleep(3000)
  await evalJs(you, `document.querySelector('[aria-label="Start live translation"]')?.click()`)

  const guestName = guestInfo.name.split(' ')[0]
  const how = hear
    ? `Speak English in the "You" window; ${guestName}'s window plays you translated.
  Wear headphones, or the translation feeds back into your mic.`
    : `Speak English in the "You" window; ${guestName} speaks from a recording.
  You read and hear ${guestName} in English; ${guestName}'s window shows your words translated.`
  console.log(`
Live translation demo is running.
  Room:  ${room.url}
  ${how}
Ctrl+C to stop.`)
}

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))

main().catch(async (err) => {
  console.error(err.message)
  await shutdown(1)
})
