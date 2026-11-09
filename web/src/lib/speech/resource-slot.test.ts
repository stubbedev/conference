import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ResourceSlot } from './resource-slot.ts'

class Resource {
  closes = 0

  close(): void {
    this.closes += 1
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void } {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test('a resource that finishes opening after the slot closed is closed, not kept', async () => {
  const slot = new ResourceSlot<Resource>()
  const opening = deferred<Resource>()
  const resource = new Resource()

  const filled = slot.fill(() => opening.promise)
  await Promise.resolve()
  slot.close()
  opening.resolve(resource)

  assert.equal(await filled, null)
  assert.equal(resource.closes, 1)
  assert.equal(slot.current, null)
})

test('closing releases the resource that is held', async () => {
  const slot = new ResourceSlot<Resource>()
  const resource = new Resource()

  await slot.fill(() => Promise.resolve(resource))
  assert.equal(slot.current, resource)
  slot.close()

  assert.equal(resource.closes, 1)
  assert.equal(slot.current, null)
})

test('a slot opens one resource however many callers fill it at once or later', async () => {
  const slot = new ResourceSlot<Resource>()
  const opening = deferred<Resource>()
  const resource = new Resource()
  let opened = 0
  const open = () => {
    opened += 1
    return opening.promise
  }

  const first = slot.fill(open)
  const second = slot.fill(open)
  opening.resolve(resource)

  assert.equal(await first, resource)
  assert.equal(await second, resource)
  assert.equal(await slot.fill(open), resource)
  assert.equal(opened, 1)
  assert.equal(resource.closes, 0)
})

test('a failed opening reaches the caller and can be tried again', async () => {
  const slot = new ResourceSlot<Resource>()
  const resource = new Resource()

  await assert.rejects(slot.fill(() => Promise.reject(new Error('loading the voice detector: network'))), /network/)

  assert.equal(await slot.fill(() => Promise.resolve(resource)), resource)
})

test('a closed slot opens nothing', async () => {
  const slot = new ResourceSlot<Resource>()
  slot.close()

  assert.equal(await slot.fill(() => assert.fail('a closed slot must not open a resource')), null)
})
