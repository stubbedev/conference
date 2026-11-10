import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'

import { readStored, storedFields, writeStored } from './storage.ts'

interface FakeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

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

function memoryStorage(entries: Record<string, string> = {}): FakeStorage {
  return {
    getItem: (key) => entries[key] ?? null,
    setItem: (key, value) => {
      entries[key] = value
    },
  }
}

function refusing(error: Error): FakeStorage {
  const refuse = () => {
    throw error
  }
  return { getItem: refuse, setItem: refuse }
}

test('a value comes back as it was written, and a missing key as undefined', (t) => {
  const warnings = useStorage(t, memoryStorage())
  writeStored('test:round-trip', { mic: true, volume: 0.5 })
  assert.deepEqual(readStored('test:round-trip'), { mic: true, volume: 0.5 })
  assert.equal(readStored('test:missing'), undefined)
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
  }
  assert.equal(readStored('test:blocked-too'), undefined)
  assert.deepEqual(
    warnings().map(([message]) => String(message).split(',')[0]),
    ['storage: reading "test:blocked"', 'storage: saving "test:blocked"', 'storage: reading "test:blocked-too"'],
  )
  assert.ok(warnings().every(([, err]) => err === blocked))
})

test('only an object has stored fields', () => {
  assert.deepEqual(storedFields<{ mic: boolean }>({ mic: 'yes' }), { mic: 'yes' })
  for (const stored of [undefined, null, 'mic', 3, true]) assert.deepEqual(storedFields(stored), {})
})
