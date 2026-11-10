import assert from 'node:assert/strict'
import { test } from 'node:test'

import { budgetFor, FIRST_GPU_BUDGET_MS, MIN_GPU_BUDGET_MS, parseHistory, withUnusable, withQuiet } from './gpu-history.ts'

const PURPOSES = ['asr', 'mt', 'tts'] as const

function stored(history: unknown): unknown {
  return JSON.parse(JSON.stringify(history))
}

test('a GPU never seen before gets the first-visit budget', () => {
  assert.equal(budgetFor(parseHistory(undefined, 'firefox', PURPOSES), 'mt'), FIRST_GPU_BUDGET_MS)
})

test('a GPU seen before gets a budget from its longest quiet stretch, within bounds', () => {
  const history = parseHistory(undefined, 'firefox', PURPOSES)
  assert.equal(budgetFor(withQuiet(history, 'mt', 5_000), 'mt'), 20_000)
  assert.equal(budgetFor(withQuiet(history, 'mt', 100), 'mt'), MIN_GPU_BUDGET_MS)
  assert.equal(budgetFor(withQuiet(history, 'mt', 40_000), 'mt'), FIRST_GPU_BUDGET_MS)
  assert.equal(budgetFor(withQuiet(history, 'mt', 5_000), 'asr'), FIRST_GPU_BUDGET_MS)
})

test('the longest quiet stretch is kept', () => {
  const history = withQuiet(withQuiet(parseHistory(undefined, 'firefox', PURPOSES), 'mt', 8_000), 'mt', 3_000)
  assert.equal(history.quietMs.mt, 8_000)
})

test('a GPU remembered as unusable stays so for the same setup', () => {
  const history = withUnusable(withQuiet(parseHistory(undefined, 'firefox 147', PURPOSES), 'asr', 2_000), 'mt')
  assert.deepEqual(parseHistory(stored(history), 'firefox 147', PURPOSES), history)
})

test('a new browser version or model setup forgets everything', () => {
  const history = withUnusable(parseHistory(undefined, 'firefox 147', PURPOSES), 'mt')
  assert.deepEqual(parseHistory(stored(history), 'firefox 148', PURPOSES), { setup: 'firefox 148', quietMs: {}, unusable: [] })
})

test('stored values that are not a history are ignored', () => {
  const history = { setup: 'firefox', quietMs: { mt: 'slow', asr: -1, tts: 4 }, unusable: ['mt', 'gpu'] }
  assert.deepEqual(parseHistory(history, 'firefox', PURPOSES), { setup: 'firefox', quietMs: { tts: 4 }, unusable: ['mt'] })
  for (const other of [[], 'firefox', 3, null]) {
    assert.deepEqual(parseHistory(other, 'firefox', PURPOSES), { setup: 'firefox', quietMs: {}, unusable: [] })
  }
})
