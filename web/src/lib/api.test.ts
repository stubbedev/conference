import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'

import { api, PasswordRefused, Unreachable } from './api.ts'

function answering(t: TestContext, body: string, init: ResponseInit): void {
  t.mock.method(globalThis, 'fetch', async () => new Response(body, init))
}

test('an answer comes back as the JSON the server sent', async (t) => {
  answering(t, '{"slug":"abc-def-ghi","requiresPassword":true}', { status: 200 })
  assert.deepEqual(await api.roomInfo('abc-def-ghi'), { slug: 'abc-def-ghi', requiresPassword: true })
})

test('a refusal fails with the message the server gave', async (t) => {
  answering(t, '{"error":"rate-limited","message":"Too many attempts; try again later."}', { status: 429 })
  await assert.rejects(api.auth('abc-def-ghi', { proof: 'x' }), (err: Error) => {
    assert.equal(err.message, 'Too many attempts; try again later.')
    assert.ok(!(err instanceof PasswordRefused))
    return true
  })
})

test('a refused or missing password is told apart by the server\'s code, not by its wording', async (t) => {
  for (const [code, message] of [
    ['bad-password', 'Wrong password.'],
    ['password-required', 'This room requires a password.'],
  ]) {
    answering(t, JSON.stringify({ error: code, message }), { status: 401 })
    await assert.rejects(api.auth('abc-def-ghi', { proof: 'x' }), (err: Error) => {
      assert.ok(err instanceof PasswordRefused)
      assert.equal(err.message, message)
      return true
    })
  }
  answering(t, '{"error":"bad-request","message":"Name or password too long."}', { status: 400 })
  await assert.rejects(api.createRoom({ name: 'x', password: 'y', maxMembers: 0 }, ''), (err: Error) => !(err instanceof PasswordRefused))
})

test('a refusal that is not the server\'s own fails with its status', async (t) => {
  answering(t, '<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' })
  await assert.rejects(api.config(), { message: 'The server answered 502 Bad Gateway' })
  answering(t, '{"error":"unavailable"}', { status: 503 })
  await assert.rejects(api.config(), { message: 'The server answered 503' })
})

test('an answer that is not JSON fails instead of reading as an empty one', async (t) => {
  answering(t, '<html>Welcome</html>', { status: 200 })
  await assert.rejects(api.config(), (err: Error) => {
    assert.equal(err.message, 'The server answered /api/config with something that is not JSON')
    assert.ok(err.cause instanceof SyntaxError)
    return true
  })
})

test('a request that gets no answer fails as unreachable, with what it asked for and why', async (t) => {
  const blip = new TypeError('Failed to fetch')
  t.mock.method(globalThis, 'fetch', async () => {
    throw blip
  })
  await assert.rejects(api.config(), (err: Error) => {
    assert.ok(err instanceof Unreachable)
    assert.equal(err.message, 'Could not reach the server for /api/config: Failed to fetch')
    assert.equal(err.cause, blip)
    return true
  })
})

test('the room lookup is tried again after a request that got no answer', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1
    if (calls === 1) throw new TypeError('Failed to fetch')
    return new Response('{"slug":"abc-def-ghi","requiresPassword":false}', { status: 200 })
  })
  assert.deepEqual(await api.roomInfo('abc-def-ghi'), { slug: 'abc-def-ghi', requiresPassword: false })
  assert.equal(calls, 2)
})

test('the room lookup is not tried again when the server refused it', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1
    return new Response('{"error":"not-found","message":"No such room."}', { status: 404 })
  })
  await assert.rejects(api.roomInfo('abc-def-ghi'), (err: Error) => !(err instanceof Unreachable) && err.message === 'No such room.')
  assert.equal(calls, 1)
})
