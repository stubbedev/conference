import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'

import { storedDisplayName } from '../lib/names.ts'
import { writeStored } from '../lib/storage.ts'
import { usePersistentState } from './persistent.ts'

const NAME_KEY = 'test:name'

function Name() {
  const [name] = usePersistentState(NAME_KEY, { parse: storedDisplayName })
  return createElement('output', null, name)
}

function mountedName(): string {
  return renderToString(createElement(Name)).replace(/<[^>]+>/g, '')
}

test('a stored name comes back on every mount, and only a missing one is drawn afresh', (t) => {
  const entries = new Map<string, string>()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    value: { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value) },
    configurable: true,
  })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  })

  assert.match(mountedName(), /^[A-Z][a-z]+ [A-Z][a-z]+$/)

  writeStored(NAME_KEY, 'Hana Sato')
  assert.equal(mountedName(), 'Hana Sato')
  assert.equal(mountedName(), 'Hana Sato')
})
