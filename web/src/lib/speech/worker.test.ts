import assert from 'node:assert/strict'
import { test } from 'node:test'

import { WorkerRpc, type WorkerReply } from './worker.ts'

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { message?: string }) => void) | null = null
  readonly posted: Record<string, unknown>[] = []

  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message)
  }

  terminate(): void {}

  reply(data: unknown): void {
    this.onmessage?.({ data })
  }

  fail(message?: string): void {
    this.onerror?.({ message })
  }
}

function rpc(): { worker: FakeWorker; rpc: WorkerRpc } {
  const worker = new FakeWorker()
  return { worker, rpc: new WorkerRpc(worker as unknown as Worker, 'voice', () => {}) }
}

test('a call is answered by the reply with its id', async () => {
  const { worker, rpc: calls } = rpc()
  const answered = calls.call<WorkerReply>({ type: 'init' })
  worker.reply({ id: worker.posted[0].id, type: 'done', level: 'full' })
  assert.deepEqual(await answered, { id: 0, type: 'done', level: 'full' })
})

test('a worker whose code never loaded fails the call that waited for it, saying which worker', async () => {
  const { worker, rpc: calls } = rpc()
  const waiting = calls.call({ type: 'init' })
  worker.fail()
  await assert.rejects(waiting, { message: 'the voice worker could not start: its code could not be loaded' })
})

test('a call made after the worker failed to load fails instead of waiting forever', async () => {
  const { worker, rpc: calls } = rpc()
  worker.fail()
  await assert.rejects(calls.call({ type: 'init' }), { message: 'the voice worker could not start: its code could not be loaded' })
  assert.deepEqual(worker.posted, [])
})

test('an error in a worker that is running fails what waits, and the worker still takes calls', async () => {
  const { worker, rpc: calls } = rpc()
  const first = calls.call<WorkerReply>({ type: 'init' })
  worker.reply({ id: 0, type: 'done' })
  await first

  const waiting = calls.call({ type: 'speak' })
  worker.fail('out of memory')
  await assert.rejects(waiting, { message: 'out of memory' })

  const next = calls.call<WorkerReply>({ type: 'speak' })
  worker.reply({ id: 2, type: 'done' })
  assert.deepEqual(await next, { id: 2, type: 'done' })
})
