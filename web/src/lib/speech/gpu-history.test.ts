import assert from 'node:assert/strict'
import { test } from 'node:test'

import { budgetFor, FIRST_GPU_BUDGET_MS, MIN_GPU_BUDGET_MS, parseHistory, withUnusable, withQuiet } from './gpu-history.ts'

const PURPOSES = ['asr', 'mt', 'tts'] as const

test('a GPU never seen before gets the first-visit budget', () => {
  assert.equal(budgetFor(parseHistory(null, 'firefox', PURPOSES), 'mt'), FIRST_GPU_BUDGET_MS)
})

test('a GPU seen before gets a budget from its longest quiet stretch, within bounds', () => {
  const history = parseHistory(null, 'firefox', PURPOSES)
  assert.equal(budgetFor(withQuiet(history, 'mt', 5_000), 'mt'), 20_000)
  assert.equal(budgetFor(withQuiet(history, 'mt', 100), 'mt'), MIN_GPU_BUDGET_MS)
  assert.equal(budgetFor(withQuiet(history, 'mt', 40_000), 'mt'), FIRST_GPU_BUDGET_MS)
  assert.equal(budgetFor(withQuiet(history, 'mt', 5_000), 'asr'), FIRST_GPU_BUDGET_MS)
})

test('the longest quiet stretch is kept', () => {
  const history = withQuiet(withQuiet(parseHistory(null, 'firefox', PURPOSES), 'mt', 8_000), 'mt', 3_000)
  assert.equal(history.quietMs.mt, 8_000)
})

test('a GPU remembered as unusable stays so for the same setup', () => {
  const history = withUnusable(withQuiet(parseHistory(null, 'firefox 147', PURPOSES), 'asr', 2_000), 'mt')
  const stored = parseHistory(JSON.stringify(history), 'firefox 147', PURPOSES)
  assert.deepEqual(stored, history)
})

test('a new browser version or model setup forgets everything', () => {
  const stored = JSON.stringify(withUnusable(parseHistory(null, 'firefox 147', PURPOSES), 'mt'))
  assert.deepEqual(parseHistory(stored, 'firefox 148', PURPOSES), { setup: 'firefox 148', quietMs: {}, unusable: [] })
})

test('stored values that are not a history are ignored', () => {
  const stored = JSON.stringify({ setup: 'firefox', quietMs: { mt: 'slow', asr: -1, tts: 4 }, unusable: ['mt', 'gpu'] })
  assert.deepEqual(parseHistory(stored, 'firefox', PURPOSES), { setup: 'firefox', quietMs: { tts: 4 }, unusable: ['mt'] })
  assert.deepEqual(parseHistory('[]', 'firefox', PURPOSES), { setup: 'firefox', quietMs: {}, unusable: [] })
})
