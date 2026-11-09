import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DeviceQueue } from './device-queue.ts'

type Kind = 'mic' | 'cam'

interface FakeTrack {
  kind: Kind
  enabled: boolean
  stopped: boolean
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class FakeMedia {
  readonly queue = new DeviceQueue<Kind>()
  readonly intent: Record<Kind, boolean> = { mic: true, cam: true }
  readonly live = new Map<Kind, FakeTrack>()
  readonly opened: FakeTrack[] = []
  readonly opens: Kind[] = []

  private open(kind: Kind): FakeTrack {
    const track = { kind, enabled: this.intent[kind], stopped: false }
    this.opened.push(track)
    return track
  }

  private adopt(track: FakeTrack): void {
    const old = this.live.get(track.kind)
    if (old) old.stopped = true
    this.live.set(track.kind, track)
  }

  acquire(gate: Promise<void>): Promise<void> {
    return this.queue.run(['mic', 'cam'], async () => {
      await gate
      for (const kind of ['mic', 'cam'] as const) this.adopt(this.open(kind))
    })
  }

  enable(kind: Kind, gate: Promise<void> = Promise.resolve()): Promise<void> {
    return this.queue.run([kind], async () => {
      if (!this.intent[kind] || this.live.has(kind)) return
      this.opens.push(kind)
      await gate
      this.adopt(this.open(kind))
    })
  }

  toggle(kind: Kind): Promise<void> {
    const { on, open } = this.queue.toggle(kind, this.intent[kind], this.live.has(kind))
    this.intent[kind] = on
    const track = this.live.get(kind)
    if (track) track.enabled = on
    return open ? this.enable(kind) : Promise.resolve()
  }

  leaked(): FakeTrack[] {
    return this.opened.filter((track) => !track.stopped && this.live.get(track.kind) !== track)
  }
}

test('muting while the first capture is still opening leaves the member muted and opens nothing more', async () => {
  const media = new FakeMedia()
  const permission = deferred()
  const acquired = media.acquire(permission.promise)

  const toggled = media.toggle('mic')
  permission.resolve()
  await Promise.all([acquired, toggled])

  assert.equal(media.intent.mic, false)
  assert.equal(media.live.get('mic')?.enabled, false)
  assert.deepEqual(media.opens, [])
  assert.equal(media.opened.length, 2)
  assert.deepEqual(media.leaked(), [])
})

test('the last toggle during the first capture is the one that sticks', async () => {
  const media = new FakeMedia()
  const permission = deferred()
  const acquired = media.acquire(permission.promise)

  void media.toggle('cam')
  void media.toggle('cam')
  void media.toggle('cam')
  permission.resolve()
  await acquired

  assert.equal(media.live.get('cam')?.enabled, false)
  assert.deepEqual(media.opens, [])
})

test('turning on a device that is not open opens it once the capture before it has settled', async () => {
  const media = new FakeMedia()
  const permission = deferred()
  const enabled = media.enable('mic', permission.promise)

  const camOpened = media.toggle('cam')
  assert.equal(media.queue.pending('cam'), true)
  permission.resolve()
  await Promise.all([enabled, camOpened])

  assert.deepEqual(media.opens, ['mic', 'cam'])
  assert.equal(media.live.get('cam')?.enabled, true)
  assert.deepEqual(media.leaked(), [])
})

test('turning a device back off before its queued opening has started opens nothing', async () => {
  const media = new FakeMedia()
  media.intent.cam = false
  const busy = deferred()
  const blocker = media.queue.run(['mic'], () => busy.promise)

  const opening = media.toggle('cam')
  assert.deepEqual(media.queue.toggle('cam', media.intent.cam, false), { on: false, open: false })
  await media.toggle('cam')
  busy.resolve()
  await Promise.all([blocker, opening])

  assert.equal(media.intent.cam, false)
  assert.deepEqual(media.opens, [])
  assert.equal(media.live.has('cam'), false)
})

test('a device is available exactly when a click on it would only flip mute', async () => {
  const queue = new DeviceQueue<Kind>()
  const busy = deferred()
  const opening = queue.run(['cam'], () => busy.promise)

  for (const kind of ['mic', 'cam'] as const) {
    for (const hasTrack of [false, true]) {
      assert.equal(queue.available(kind, hasTrack), !queue.toggle(kind, false, hasTrack).open)
    }
  }
  assert.equal(queue.available('mic', false), false)
  assert.equal(queue.available('mic', true), true)
  assert.equal(queue.available('cam', false), true)

  busy.resolve()
  await opening
  assert.equal(queue.available('cam', false), false)
})

test('subscribers can see a device become pending and stop being pending, also when opening it fails', async () => {
  const queue = new DeviceQueue<Kind>()
  const seen: boolean[] = []
  const unsubscribe = queue.subscribe(() => seen.push(queue.pending('cam')))
  const busy = deferred()

  const opened = queue.run(['cam'], () => busy.promise)
  busy.resolve()
  await opened
  await assert.rejects(queue.run(['cam'], () => Promise.reject(new Error('opening the camera: NotAllowedError'))))
  assert.deepEqual(seen, [true, false, true, false])

  unsubscribe()
  await queue.run(['cam'], async () => {})
  assert.equal(seen.length, 4)
})

test('work that claims no device does not notify subscribers', async () => {
  const queue = new DeviceQueue<Kind>()
  let notified = 0
  queue.subscribe(() => {
    notified += 1
  })

  await queue.run([], async () => {})

  assert.equal(notified, 0)
})

test('operations never overlap, so a second capture cannot replace the first one half-way', async () => {
  const queue = new DeviceQueue<Kind>()
  let running = 0
  let most = 0
  const op = () =>
    queue.run(['mic'], async () => {
      running += 1
      most = Math.max(most, running)
      await new Promise((resolve) => setTimeout(resolve, 1))
      running -= 1
    })

  await Promise.all([op(), op(), op()])
  assert.equal(most, 1)
  assert.equal(queue.pending('mic'), false)
})

test('a failed operation releases its claim and lets the next one run', async () => {
  const queue = new DeviceQueue<Kind>()
  const failed = queue.run(['cam'], () => Promise.reject(new Error('opening the camera: NotAllowedError')))
  const next = queue.run(['cam'], async () => {})

  await assert.rejects(failed, /NotAllowedError/)
  await next
  assert.equal(queue.pending('cam'), false)
})

test('closing releases what exists now, skips queued work and releases what the running operation opens', async () => {
  const media = new FakeMedia()
  const permission = deferred()
  const acquired = media.acquire(permission.promise)
  await new Promise((resolve) => setImmediate(resolve))
  const queued = media.enable('mic')
  let teardowns = 0

  const closed = media.queue.close(() => {
    teardowns += 1
    for (const track of media.live.values()) track.stopped = true
    media.live.clear()
  })
  assert.equal(teardowns, 1)
  permission.resolve()
  await Promise.all([acquired, queued, closed])

  assert.equal(teardowns, 2)
  assert.deepEqual(media.opens, [])
  assert.ok(media.opened.every((track) => track.stopped))
  await media.enable('cam')
  assert.equal(media.opened.length, 2)
})
