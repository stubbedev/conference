import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  describeAskFailure,
  describeLostSpeaker,
  describeSinkFailure,
  detectAudioOutputs,
  planSink,
} from './audio-output.ts'

test('a browser without setSinkId plays through the system output whatever else it has', () => {
  assert.equal(detectAudioOutputs({}, { selectAudioOutput: async () => ({}) }).picking, 'system')
  assert.equal(detectAudioOutputs(undefined, undefined).picking, 'system')
})

test('setSinkId alone means the outputs are listed, with selectAudioOutput they are asked for', () => {
  const element = { setSinkId: async () => {} }
  assert.equal(detectAudioOutputs(element, {}).picking, 'listed')
  assert.equal(detectAudioOutputs(element, { selectAudioOutput: 'not a function' }).picking, 'listed')
  assert.equal(detectAudioOutputs(element, { selectAudioOutput: async () => ({}) }).picking, 'prompted')
})

test('asking passes the remembered device as a hint and nothing for a fresh choice', async () => {
  const calls: unknown[] = []
  const devices = {
    selectAudioOutput: async (options: unknown) => {
      calls.push(options)
      return { deviceId: 'chosen' }
    },
  }
  const outputs = detectAudioOutputs({ setSinkId: async () => {} }, devices)
  assert.equal(outputs.picking, 'prompted')
  if (outputs.picking !== 'prompted') return
  await outputs.ask()
  await outputs.ask('remembered')
  assert.deepEqual(calls, [{}, { deviceId: 'remembered' }])
})

test('the system default and a system-output browser need no sink', () => {
  assert.deepEqual(planSink('listed', '', ['a'], true), { kind: 'default' })
  assert.deepEqual(planSink('system', 'a', ['a'], true), { kind: 'default' })
})

test('a listed choice is tried, an unlisted one waits until the devices are known and is lost after', () => {
  assert.deepEqual(planSink('prompted', 'a', ['a', 'b'], false), { kind: 'try', deviceId: 'a' })
  assert.deepEqual(planSink('prompted', 'a', [], false), { kind: 'wait' })
  assert.deepEqual(planSink('prompted', 'a', ['b'], true), { kind: 'lost', deviceId: 'a' })
  assert.deepEqual(planSink('listed', 'a', [], true), { kind: 'lost', deviceId: 'a' })
})

test('every speaker failure says the audio moved to the system default', () => {
  const failures = [
    describeLostSpeaker('listed'),
    describeLostSpeaker('prompted'),
    describeSinkFailure(new DOMException('', 'NotFoundError')),
    describeSinkFailure(new DOMException('', 'NotAllowedError')),
    describeSinkFailure(new DOMException('', 'AbortError')),
    describeSinkFailure(new TypeError('bad id')),
  ]
  for (const message of failures) assert.match(message, /plays through the system default/)
  assert.match(describeLostSpeaker('prompted'), /choose the speaker again/)
  assert.match(describeSinkFailure(new TypeError('bad id')), /TypeError: bad id/)
})

test('closing the browser picker is no failure, anything else is described', () => {
  assert.equal(describeAskFailure(new DOMException('', 'NotAllowedError')), null)
  assert.match(describeAskFailure(new DOMException('', 'InvalidStateError')) ?? '', /right after a click/)
  assert.match(describeAskFailure(new DOMException('', 'NotFoundError')) ?? '', /no speakers/)
  assert.match(describeAskFailure('gone') ?? '', /\(gone\)/)
})
