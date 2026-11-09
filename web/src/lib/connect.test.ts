import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectAndPublish, type Publisher } from './connect.ts'

type Stream = 'empty' | 'mic'

function client(onConnect: () => void, fail?: Error): Publisher<Stream> & { published: Stream[] } {
  const published: Stream[] = []
  return {
    published,
    async connect() {
      await Promise.resolve()
      onConnect()
      if (fail) throw fail
    },
    async publish(stream) {
      published.push(stream)
    },
  }
}

test('publishes the microphone that was acquired while the room was still connecting', async () => {
  let local: Stream = 'empty'
  const room = client(() => {
    local = 'mic'
  })

  const published = await connectAndPublish(room, () => local)

  assert.equal(published, 'mic')
  assert.deepEqual(room.published, ['mic'])
})

test('publishes what is there once connected when nothing arrives meanwhile', async () => {
  const room = client(() => {})

  assert.equal(await connectAndPublish(room, (): Stream => 'empty'), 'empty')
  assert.deepEqual(room.published, ['empty'])
})

test('publishes nothing when the connection fails', async () => {
  const failure = new Error('signaling closed')
  const room = client(() => {}, failure)

  await assert.rejects(connectAndPublish(room, (): Stream => 'mic'), failure)
  assert.deepEqual(room.published, [])
})
