import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'

import { queryPermission } from './permission.ts'

function warnings(t: TestContext): () => unknown[][] {
  const warn = t.mock.method(console, 'warn', () => {})
  return () => warn.mock.calls.map((call) => call.arguments)
}

function answering(answer: () => Promise<PermissionStatus>): Pick<Permissions, 'query'> {
  return { query: answer }
}

test('a browser that knows the permission gives its status', async (t) => {
  const warned = warnings(t)
  const status = { state: 'granted' } as PermissionStatus
  const asked: PermissionDescriptor[] = []
  const permissions: Pick<Permissions, 'query'> = {
    query: async (descriptor) => {
      asked.push(descriptor)
      return status
    },
  }
  assert.equal(await queryPermission(permissions, 'camera'), status)
  assert.deepEqual(asked, [{ name: 'camera' }])
  assert.deepEqual(warned(), [])
})

test('a browser without the API, or whose API does not know the name, is unknown and not a failure', async (t) => {
  const warned = warnings(t)
  const unknownName = new TypeError("'camera' is not a valid value for enumeration PermissionName.")
  assert.equal(await queryPermission(undefined, 'camera'), 'unknown')
  assert.equal(await queryPermission(answering(() => Promise.reject(unknownName)), 'camera'), 'unknown')
  assert.deepEqual(warned(), [])
})

test('any other rejection is unknown too, and reported with what was asked', async (t) => {
  const warned = warnings(t)
  const inactive = new DOMException('The document is not fully active.', 'InvalidStateError')
  assert.equal(await queryPermission(answering(() => Promise.reject(inactive)), 'microphone'), 'unknown')
  assert.deepEqual(warned(), [['permission: asking the browser about "microphone"', inactive]])
})
