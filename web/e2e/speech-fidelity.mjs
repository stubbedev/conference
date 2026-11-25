import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { invented } from '../src/lib/speech/invented.ts'
import { renderPrompt } from '../src/lib/speech/models.ts'
import { EARLIER_SENTENCES, Sentences } from '../src/lib/speech/sentences.ts'
import { MIN_UTTERANCE_SAMPLES } from '../src/lib/speech/vad.ts'
import { languageName } from '../src/lib/translate/languages.ts'
import { evalJs, findChrome, launchChrome, sleep, stopProcess } from './browser.mjs'
import { MAX_WORD_ERROR_RATE, MIN_RECORDING_CHRF, MIN_SENTENCE_CHRF, readOracle, scoreTranslations, wordErrorRate } from './fidelity.mjs'
import { builtWorker, serveSpeechPage, workerProbe } from './speech-page.mjs'
import { serveModels, shutdown } from './translate-stack.mjs'

const models = process.env.SPEECH_MODEL_DIR
if (!models) {
  console.error('SPEECH_MODEL_DIR is not set: point it at a directory whose models.json fetch-speech-models.mjs wrote')
  process.exit(2)
}

const chrome = process.env.CHROME ?? findChrome()
const TIMEOUT_MS = 900_000
const CAPTURE_CHUNK = 320

const oracle = readOracle()
const dir = mkdtempSync(join(tmpdir(), 'speech-fidelity-'))
const failures = []

function check(label, condition, detail) {
  if (!condition) failures.push(`${label}: ${detail}`)
}

function transcriptionProbe(chosen) {
  return workerProbe(
    { vad: builtWorker('vad'), asr: builtWorker('asr') },
    `
  const runtime = await fetchRuntime()
  await workers.vad.ask({ type: 'init', base: '/vad/', runtime })
  const heard = {}
  let asrReady = false
  for (const { recording, lang } of ${JSON.stringify(oracle.map(({ recording, lang }) => ({ recording, lang })))}) {
    const url = '/fixtures/' + recording
    const samples = await readWav(url)
    const before = workers.vad.events.length
    for (let at = 0; at < samples.length; at += ${CAPTURE_CHUNK}) await workers.vad.ask({ type: 'audio', pcm: samples.slice(at, at + ${CAPTURE_CHUNK}) })
    await workers.vad.ask({ type: 'audio', pcm: new Int16Array(16000) })
    await workers.vad.ask({ type: 'flush' })
    await workers.vad.ask({ type: 'reset' })
    const ended = workers.vad.events.slice(before).filter((event) => event.event === 'segment' && event.kind !== 'partial')
    if (!asrReady) {
      await workers.asr.ask({ type: 'init', gpu: true, base: ${JSON.stringify(chosen.base)}, runtime, asr: ${JSON.stringify(chosen.asr)}, sizes: ${JSON.stringify(chosen.sizes)}, lang })
      asrReady = true
    }
    heard[recording] = []
    for (const { kind, audio, cut } of ended) {
      if (kind === 'stopped') heard[recording].push({ kind })
      else if (audio.length >= ${MIN_UTTERANCE_SAMPLES}) heard[recording].push({ kind, cut, text: (await workers.asr.ask({ type: 'transcribe', audio, lang })).text })
    }
  }
  return { heard }
`,
  )
}

function translationProbe(chosen, jobs) {
  return workerProbe(
    { mt: builtWorker('mt') },
    `
  await workers.mt.ask({ type: 'init', gpu: true, base: ${JSON.stringify(chosen.base)}, runtime: await fetchRuntime(), mt: ${JSON.stringify(chosen.mt)}, sizes: ${JSON.stringify(chosen.sizes)} })
  const translated = []
  for (const { text, source, target, system } of ${JSON.stringify(jobs)}) translated.push((await workers.mt.ask({ type: 'translate', text, source, target, system })).text)
  return { translated }
`,
  )
}

async function lines(ended) {
  const sentences = new Sentences()
  const finals = []
  for (const segment of ended) {
    if (segment.kind === 'stopped') {
      const held = sentences.expire()
      if (held) finals.push(held.text)
      continue
    }
    const text = segment.text.trim()
    if (!text || (await invented(text))) continue
    const line = sentences.utterance(text, segment.cut)
    if (line?.final) finals.push(line.text)
  }
  const held = sentences.expire()
  if (held) finals.push(held.text)
  return finals
}

async function probe(browser, label, expression) {
  const value = await Promise.race([evalJs(browser, expression), sleep(TIMEOUT_MS).then(() => ({ error: 'timed out' }))])
  if (!value || value.error) throw new Error(`${label}: ${value?.error ?? 'no answer'}`)
  return value
}

async function main() {
  const { base, chosen, languages } = await serveModels(dir, models)
  const language = (code) => ({ code, name: languageName(languages, code) })
  const system = (source, target, earlier) => (chosen.prompt ? renderPrompt(chosen.prompt, language(source), language(target), earlier) : '')
  const server = await serveSpeechPage({ modelServer: base })
  const browser = await launchChrome(chrome, 0, dir, [], { gpu: process.env.GPU === '1' })
  try {
    await browser.cdp.send('Page.navigate', { url: `${server.origin}/` }, browser.sessionId)
    await sleep(1_000)

    const { heard } = await probe(browser, 'transcription', transcriptionProbe(chosen))
    const jobs = []
    for (const [entry, expected] of oracle.entries()) {
      const source = expected.lang
      const said = await lines(heard[expected.recording])
      const transcript = said.join(' ')
      const wer = wordErrorRate(transcript, expected.sentences.join(' '))
      console.log(`\n${expected.recording}, ${expected.speech} ${source} speech, heard (WER ${(wer * 100).toFixed(1)}%):`)
      for (const line of said) console.log(`  ${line}`)
      check(`transcription ${expected.recording}`, wer <= MAX_WORD_ERROR_RATE, `word error rate ${(wer * 100).toFixed(1)}% over ${(MAX_WORD_ERROR_RATE * 100).toFixed(0)}%: ${JSON.stringify(transcript)}`)
      for (const target of Object.keys(expected.translations)) {
        for (const [at, text] of said.entries()) {
          jobs.push({ entry, source, target, at, text, system: system(source, target, said.slice(Math.max(0, at - EARLIER_SENTENCES), at)) })
        }
      }
    }

    const { translated } = await probe(browser, 'translation', translationProbe(chosen, jobs))
    const byPair = new Map()
    for (const [index, job] of jobs.entries()) {
      const pair = `${oracle[job.entry].recording} ${job.source}-${job.target}`
      byPair.set(pair, [...(byPair.get(pair) ?? []), { ...job, translation: translated[index] }])
    }
    for (const [pair, results] of byPair) {
      const { entry, target } = results[0]
      const expected = oracle[entry]
      const references = expected.translations[target]
      const scored = scoreTranslations(results, expected.sentences, references)
      console.log(`\n${pair} (chrF ${scored.whole.toFixed(1)}):`)
      check(`translation ${pair}`, scored.whole >= MIN_RECORDING_CHRF, `chrF ${scored.whole.toFixed(1)} under ${MIN_RECORDING_CHRF}`)
      for (const { which, said, translation, score, reference } of scored.sentences) {
        console.log(`  ${score.toFixed(1).padStart(5)}  [${which}] ${said}\n         ${translation}`)
        check(
          `translation ${pair}, sentence ${which}`,
          score >= MIN_SENTENCE_CHRF,
          `chrF ${score.toFixed(1)} under ${MIN_SENTENCE_CHRF}: ${JSON.stringify(translation)} for ${JSON.stringify(said)}, reference ${JSON.stringify(reference)}`,
        )
      }
    }
  } finally {
    await stopProcess(browser.proc)
    server.close()
  }
}

try {
  await main()
} catch (err) {
  failures.push(`setup: ${err.message}`)
}
if (failures.length) {
  console.error('\nSPEECH FIDELITY E2E FAILED')
  for (const failure of failures) console.error(`  - ${failure}`)
} else {
  console.log('\nSPEECH FIDELITY E2E OK: the recordings came back as the subtitles and translations the oracle knows')
}
rmSync(dir, { recursive: true, force: true })
await shutdown(failures.length ? 1 : 0)
