import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { parseServerMessage, SERVER_MESSAGE_SHAPES } from './signalling.ts'

const written = JSON.parse(readFileSync(new URL('../../../fixtures/signalling.json', import.meta.url), 'utf8')) as Record<string, unknown>[]

function shape(type: unknown, fields: readonly string[]): string {
  return `${String(type)}: ${[...fields].sort().join(' ')}`
}

function shapeOf(message: Record<string, unknown>): string {
  const { type, ...fields } = message
  return shape(type, Object.keys(fields))
}

function refusal(message: unknown): string {
  const parsed = parseServerMessage(JSON.stringify(message))
  assert.ok('refused' in parsed, `${JSON.stringify(message)} is read`)
  return parsed.refused
}

const joined = { type: 'member-joined', id: 'cy', short: 3, name: 'Cy', replaces: '' }

test('every message the server writes is read as it was written', () => {
  for (const message of written) assert.deepEqual(parseServerMessage(JSON.stringify(message)), message)
})

test('the client reads exactly the shapes the server writes', () => {
  const server = written.map(shapeOf).sort()
  const client = SERVER_MESSAGE_SHAPES.map(({ type, fields }) => shape(type, fields)).sort()
  assert.deepEqual(client, server)
})

test('a message missing a field the server always writes is refused, naming the field', () => {
  assert.equal(refusal({ type: 'member-joined', id: 'cy', short: 3, replaces: '' }), 'its name is not a non-empty string')
  assert.equal(refusal({ type: 'translating', from: 'anna' }), 'its on is not a boolean')
  assert.equal(refusal({ ...joined, short: -1 }), 'its short is not a whole number')
})

test('a nested field is named by its path', () => {
  const welcome = written.find((message) => message.type === 'welcome')
  assert.ok(welcome)
  assert.equal(refusal({ ...welcome, self: { ...(welcome.self as object), mic: 'yes' } }), 'its self.mic is not a boolean')
  assert.equal(refusal({ ...welcome, iceServers: [] }), 'its iceServers is empty')
})

test('a forced action is one of the actions, and a language set by a host comes sealed', () => {
  assert.deepEqual(parseServerMessage(JSON.stringify({ type: 'forced', action: 'cam' })), { type: 'forced', action: 'cam' })
  assert.match(refusal({ type: 'forced', action: 'kick' }), /its action is not one of mute, cam, screen/)
  assert.match(refusal({ type: 'forced', action: 'lang' }), /its from is not a non-empty string/)
})

test('what is not a message the client knows is refused', () => {
  assert.deepEqual(parseServerMessage('['), { refused: 'it is not JSON' })
  assert.deepEqual(parseServerMessage(new ArrayBuffer(1)), { refused: 'it is not text' })
  assert.deepEqual(parseServerMessage('[]'), { refused: 'it is not an object' })
  assert.deepEqual(parseServerMessage('{"type":"welcomed"}'), { refused: 'its type "welcomed" is not one this client knows' })
})
