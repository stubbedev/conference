import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'

import { readStored, readStoredText, removeStoredWithPrefix, storedFields, writeStored, writeStoredText } from './storage.ts'

type FakeStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>

function useStorage(t: TestContext, storage: FakeStorage): () => unknown[][] {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })
  const warn = t.mock.method(console, 'warn', () => {})
  return () => warn.mock.calls.map((call) => call.arguments)
}

function memoryStorage(initial: Record<string, string> = {}): FakeStorage {
  const entries = new Map(Object.entries(initial))
  return {
    get length() {
      return entries.size
    },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value)
    },
    removeItem: (key) => {
      entries.delete(key)
    },
  }
}

function refusing(error: Error): FakeStorage {
  const refuse = () => {
    throw error
  }
  return {
    get length(): number {
      return refuse()
    },
    key: refuse,
    getItem: refuse,
    setItem: refuse,
    removeItem: refuse,
  }
}

test('a value comes back as it was written, and a missing key as undefined', (t) => {
  const warnings = useStorage(t, memoryStorage())
  writeStored('test:round-trip', { mic: true, volume: 0.5 })
  assert.deepEqual(readStored('test:round-trip'), { mic: true, volume: 0.5 })
  assert.equal(readStored('test:missing'), undefined)
  assert.deepEqual(warnings(), [])
})

test('text is stored as it is, not as JSON', (t) => {
  const storage = memoryStorage({ 'test:bare': 'light' })
  const warnings = useStorage(t, storage)
  assert.equal(readStoredText('test:bare'), 'light')
  writeStoredText('test:bare', 'dark')
  assert.equal(storage.getItem('test:bare'), 'dark')
  assert.equal(readStoredText('test:missing'), undefined)
  assert.deepEqual(warnings(), [])
})

test('a value that is not JSON reads as undefined and says which key', (t) => {
  const warnings = useStorage(t, memoryStorage({ 'test:corrupt': '{"mic":' }))
  assert.equal(readStored('test:corrupt'), undefined)
  const [[message, err], ...more] = warnings()
  assert.match(String(message), /^storage: reading "test:corrupt"/)
  assert.ok(err instanceof SyntaxError)
  assert.deepEqual(more, [])
})

test('a blocked store keeps the caller going and reports each key once per direction', (t) => {
  const blocked = new DOMException('The operation is insecure.', 'SecurityError')
  const warnings = useStorage(t, refusing(blocked))
  for (let i = 0; i < 3; i++) {
    assert.equal(readStored('test:blocked'), undefined)
    writeStored('test:blocked', i)
    assert.equal(readStoredText('test:blocked'), undefined)
    writeStoredText('test:blocked', 'text')
    removeStoredWithPrefix('test:blocked')
  }
  assert.equal(readStored('test:blocked-too'), undefined)
  assert.deepEqual(
    warnings().map(([message]) => String(message).split(',')[0]),
    [
      'storage: reading "test:blocked"',
      'storage: saving "test:blocked"',
      'storage: removing the keys that start with "test:blocked"',
      'storage: reading "test:blocked-too"',
    ],
  )
  assert.ok(warnings().every(([, err]) => err === blocked))
})

test('only the keys that start with a prefix are removed', (t) => {
  const storage = memoryStorage({ 'test:retired:a': '1', 'test:kept': '2', 'test:retired:b': '3', 'other:test:retired:': '4' })
  const warnings = useStorage(t, storage)
  removeStoredWithPrefix('test:retired:')
  assert.deepEqual(
    Array.from({ length: storage.length }, (_, index) => storage.key(index)),
    ['test:kept', 'other:test:retired:'],
  )
  assert.deepEqual(warnings(), [])
})

test('only an object has stored fields', () => {
  assert.deepEqual(storedFields<{ mic: boolean }>({ mic: 'yes' }), { mic: 'yes' })
  for (const stored of [undefined, null, 'mic', 3, true]) assert.deepEqual(storedFields(stored), {})
})
