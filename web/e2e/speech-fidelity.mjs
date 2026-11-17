import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { invented, normalized } from '../src/lib/speech/invented.ts'
import { renderPrompt } from '../src/lib/speech/models.ts'
import { EARLIER_SENTENCES, Sentences } from '../src/lib/speech/sentences.ts'
import { MIN_UTTERANCE_SAMPLES } from '../src/lib/speech/vad.ts'
import { languageName } from '../src/lib/translate/languages.ts'
import { evalJs, findChrome, launchChrome, sleep, stopProcess } from './browser.mjs'
import { builtWorker, serveSpeechPage, workerProbe } from './speech-page.mjs'
import { repoRoot, serveModels, shutdown } from './translate-stack.mjs'

const models = process.env.SPEECH_MODEL_DIR
if (!models) {
  console.error('SPEECH_MODEL_DIR is not set: point it at a directory whose models.json fetch-speech-models.mjs wrote')
  process.exit(2)
}

const chrome = process.env.CHROME ?? findChrome()
const TIMEOUT_MS = 900_000
const CAPTURE_CHUNK = 320
const MAX_WORD_ERROR_RATE = 0.1
const MIN_SENTENCE_CHRF = 40
const MIN_RECORDING_CHRF = 50

const oracle = JSON.parse(readFileSync(join(repoRoot, 'fixtures', 'speech-oracle.json'), 'utf8'))
const dir = mkdtempSync(join(tmpdir(), 'speech-fidelity-'))
const failures = []

function check(label, condition, detail) {
  if (!condition) failures.push(`${label}: ${detail}`)
}

function wordsOf(text) {
  const words = normalized(text)
  return words ? words.split(' ') : []
}

function editDistance(said, meant) {
  let previous = Array.from({ length: meant.length + 1 }, (_, at) => at)
  for (let row = 1; row <= said.length; row++) {
    const current = [row]
    for (let at = 1; at <= meant.length; at++) {
      const substitution = previous[at - 1] + (said[row - 1] === meant[at - 1] ? 0 : 1)
      current.push(Math.min(substitution, previous[at] + 1, current[at - 1] + 1))
    }
    previous = current
  }
  return previous[meant.length]
}

function wordErrorRate(said, meant) {
  const meantWords = wordsOf(meant)
  return editDistance(wordsOf(said), meantWords) / meantWords.length
}

function ngrams(text, n) {
  const chars = [...text.normalize('NFC').toLowerCase().replace(/\s+/gu, '')]
  const counts = new Map()
  for (let at = 0; at + n <= chars.length; at++) {
    const gram = chars.slice(at, at + n).join('')
    counts.set(gram, (counts.get(gram) ?? 0) + 1)
  }
  return counts
}

function chrF(hypothesis, reference) {
  const BETA = 2
  let precision = 0
  let recall = 0
  let orders = 0
  for (let n = 1; n <= 6; n++) {
    const made = ngrams(hypothesis, n)
    const meant = ngrams(reference, n)
    const madeTotal = [...made.values()].reduce((sum, count) => sum + count, 0)
    const meantTotal = [...meant.values()].reduce((sum, count) => sum + count, 0)
    if (madeTotal === 0 || meantTotal === 0) continue
    let common = 0
    for (const [gram, count] of made) common += Math.min(count, meant.get(gram) ?? 0)
    precision += common / madeTotal
    recall += common / meantTotal
    orders += 1
  }
  if (orders === 0) return 0
  precision /= orders
  recall /= orders
  if (precision + recall === 0) return 0
  return (100 * (1 + BETA ** 2) * precision * recall) / (BETA ** 2 * precision + recall)
}

function wordAlignment(said, meant) {
  const cost = Array.from({ length: said.length + 1 }, (_, row) => Array.from({ length: meant.length + 1 }, (_, at) => (row === 0 ? at : at === 0 ? row : 0)))
  for (let row = 1; row <= said.length; row++) {
    for (let at = 1; at <= meant.length; at++) {
      cost[row][at] = Math.min(cost[row - 1][at - 1] + (said[row - 1].word === meant[at - 1].word ? 0 : 1), cost[row - 1][at] + 1, cost[row][at - 1] + 1)
    }
  }
  const pairs = []
  let row = said.length
  let at = meant.length
  while (row > 0 && at > 0) {
    if (cost[row][at] === cost[row - 1][at - 1] + (said[row - 1].word === meant[at - 1].word ? 0 : 1)) {
      pairs.push([said[row - 1].index, meant[at - 1].index])
      row -= 1
      at -= 1
    } else if (cost[row][at] === cost[row - 1][at] + 1) row -= 1
    else at -= 1
  }
  return pairs
}

function indexedWords(texts) {
  return texts.flatMap((text, index) => wordsOf(text).map((word) => ({ word, index })))
}

function alignedGroups(lines, sentences) {
  const parent = new Map()
  const find = (node) => (parent.get(node) === node ? node : find(parent.get(node)))
  const unite = (a, b) => parent.set(find(a), find(b))
  for (const [at] of lines.entries()) parent.set(`l${at}`, `l${at}`)
  for (const [at] of sentences.entries()) parent.set(`s${at}`, `s${at}`)

  const linked = new Set()
  for (const [line, sentence] of wordAlignment(indexedWords(lines), indexedWords(sentences))) {
    unite(`l${line}`, `s${sentence}`)
    linked.add(line)
  }
  for (const [at] of lines.entries()) if (!linked.has(at) && at > 0) unite(`l${at}`, `l${at - 1}`)

  const groups = new Map()
  for (const node of parent.keys()) {
    const root = find(node)
    const group = groups.get(root) ?? { lines: [], sentences: [] }
    group[node[0] === 'l' ? 'lines' : 'sentences'].push(Number(node.slice(1)))
    groups.set(root, group)
  }
  const first = (group) => Math.min(...group.sentences, ...group.lines.map((line) => line + 0.5))
  return [...groups.values()].map((group) => ({ lines: group.lines.sort((a, b) => a - b), sentences: group.sentences.sort((a, b) => a - b) })).sort((a, b) => first(a) - first(b))
}

function variants(reference) {
  return Array.isArray(reference) ? reference : [reference]
}

function bestReference(hypothesis, references) {
  let best = { score: 0, reference: '' }
  const pick = (at, chosen) => {
    if (at === references.length) {
      const reference = chosen.join(' ')
      const score = chrF(hypothesis, reference)
      if (score > best.score) best = { score, reference }
      return
    }
    for (const variant of variants(references[at])) pick(at + 1, [...chosen, variant])
  }
  pick(0, [])
  return best
}

function transcriptionProbe(chosen) {
  return workerProbe(
    { vad: builtWorker('vad'), asr: builtWorker('asr') },
    `
  const runtime = await fetchRuntime()
  await workers.vad.ask({ type: 'init', base: '/vad/', runtime })
  const heard = {}
  let asrReady = false
  for (const [lang, url] of ${JSON.stringify(Object.entries(oracle).map(([lang, { recording }]) => [lang, `/fixtures/${recording}`]))}) {
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
    heard[lang] = []
    for (const { kind, audio, cut } of ended) {
      if (kind === 'stopped') heard[lang].push({ kind })
      else if (audio.length >= ${MIN_UTTERANCE_SAMPLES}) heard[lang].push({ kind, cut, text: (await workers.asr.ask({ type: 'transcribe', audio, lang })).text })
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
    for (const [source, expected] of Object.entries(oracle)) {
      const said = await lines(heard[source])
      const transcript = said.join(' ')
      const wer = wordErrorRate(transcript, expected.sentences.join(' '))
      console.log(`\n${source} heard (WER ${(wer * 100).toFixed(1)}%):`)
      for (const line of said) console.log(`  ${line}`)
      check(`transcription ${source}`, wer <= MAX_WORD_ERROR_RATE, `word error rate ${(wer * 100).toFixed(1)}% over ${(MAX_WORD_ERROR_RATE * 100).toFixed(0)}%: ${JSON.stringify(transcript)}`)
      for (const target of Object.keys(expected.translations)) {
        for (const [at, text] of said.entries()) {
          jobs.push({ source, target, at, text, system: system(source, target, said.slice(Math.max(0, at - EARLIER_SENTENCES), at)) })
        }
      }
    }

    const { translated } = await probe(browser, 'translation', translationProbe(chosen, jobs))
    const byPair = new Map()
    for (const [index, job] of jobs.entries()) {
      const pair = `${job.source}-${job.target}`
      byPair.set(pair, [...(byPair.get(pair) ?? []), { ...job, translation: translated[index] }])
    }
    for (const [pair, results] of byPair) {
      const [source, target] = pair.split('-')
      const references = oracle[source].translations[target]
      const whole = bestReference(results.map((result) => result.translation).join(' '), references).score
      console.log(`\n${pair} (chrF ${whole.toFixed(1)}):`)
      check(`translation ${pair}`, whole >= MIN_RECORDING_CHRF, `chrF ${whole.toFixed(1)} under ${MIN_RECORDING_CHRF}`)
      for (const group of alignedGroups(results.map((result) => result.text), oracle[source].sentences)) {
        const said = group.lines.map((line) => results[line].text).join(' ')
        const translation = group.lines.map((line) => results[line].translation).join(' ')
        const { score, reference } = bestReference(translation, group.sentences.map((sentence) => references[sentence]))
        const which = group.sentences.map((sentence) => sentence + 1).join('+') || 'none'
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
