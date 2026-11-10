import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { WorkerReply } from './worker.ts'
import { Workers } from './workers.ts'

class FakePort {
  readonly id: number
  closed = false

  constructor(id: number) {
    this.id = id
  }

  close(): void {
    this.closed = true
  }
}

function pool(): { workers: Workers<string, FakePort>; opened: FakePort[] } {
  const opened: FakePort[] = []
  const workers = new Workers<string, FakePort>(() => {
    const port = new FakePort(opened.length)
    opened.push(port)
    return port
  })
  return { workers, opened }
}

const done: WorkerReply = { type: 'done' }

test('a worker that loaded is kept and its load is not repeated', async () => {
  const { workers, opened } = pool()
  let inits = 0
  const init = async () => {
    inits += 1
    return done
  }

  await workers.load('asr', init)
  await workers.load('asr', init)

  assert.equal(inits, 1)
  assert.equal(opened.length, 1)
  assert.equal(workers.port('asr'), opened[0])
})

test('a worker whose load failed is thrown away, and the next load starts a fresh one', async () => {
  const { workers, opened } = pool()

  await assert.rejects(
    workers.load('tts', async () => {
      throw new Error("previous call to 'initWasm()' failed.")
    }),
    /initWasm/,
  )
  assert.equal(opened[0].closed, true)

  const used: number[] = []
  await workers.load('tts', async (port) => {
    used.push(port.id)
    return done
  })

  assert.deepEqual(used, [1])
  assert.equal(opened[1].closed, false)
})

test('a load that fails after its worker was replaced leaves the replacement alone', async () => {
  const { workers, opened } = pool()
  let fail: (err: Error) => void = () => {}
  const first = workers.load('vad', () => new Promise<WorkerReply>((_resolve, reject) => (fail = reject)))

  workers.close('vad')
  const second = workers.load('vad', async () => done)
  fail(new Error('the speech worker is closed'))

  await assert.rejects(first, /closed/)
  assert.equal(await second, done)
  assert.equal(opened[1].closed, false)
  assert.equal(workers.port('vad'), opened[1])
})
