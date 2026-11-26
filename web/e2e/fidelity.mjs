import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalized } from '../src/lib/speech/invented.ts'
import { repoRoot } from './server.mjs'

export const FIXTURES = join(repoRoot, 'fixtures')
export const MAX_WORD_ERROR_RATE = 0.1
export const MIN_SENTENCE_CHRF = 40
export const MIN_RECORDING_CHRF = 50

export function readOracle() {
  return JSON.parse(readFileSync(join(FIXTURES, 'speech-oracle.json'), 'utf8'))
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

export function wordErrorRate(said, meant) {
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

export function chrF(hypothesis, reference) {
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

export function scoreTranslations(results, sentences, references) {
  const whole = bestReference(results.map((result) => result.translation).join(' '), references).score
  const scored = alignedGroups(results.map((result) => result.text), sentences).map((group) => {
    const said = group.lines.map((line) => results[line].text).join(' ')
    const translation = group.lines.map((line) => results[line].translation).join(' ')
    const { score, reference } = bestReference(translation, group.sentences.map((sentence) => references[sentence]))
    const which = group.sentences.map((sentence) => sentence + 1).join('+') || 'none'
    return { which, said, translation, score, reference }
  })
  return { whole, sentences: scored }
}
