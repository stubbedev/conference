import assert from 'node:assert/strict'
import { test } from 'node:test'

import { errorVerdict, FETCH_ATTEMPTS, headFirst, headFirstFetch, resilientFetch, retryDelay, statusVerdict, type FetchDeps, type Retrying } from './fetching.ts'

const URL_ = '/speech/model.onnx'
const BYTES = Uint8Array.from({ length: 10 }, (_, i) => i)

interface Call {
  url: string
  method: string
  range: string | null
  ifRange: string | null
}

type Answer = Response | Error

function brokenAfter(bytes: Uint8Array, headers: Record<string, string>, status = 200): Response {
  let sent = false
  const body = new ReadableStream<Uint8Array>({
    pull: (controller) => {
      if (sent) {
        controller.error(new TypeError('network error'))
        return
      }
      sent = true
      controller.enqueue(bytes)
    },
  })
  return new Response(body, { status, headers })
}

function harness(answers: Answer[]): { deps: FetchDeps; calls: Call[]; retries: Retrying[]; sleeps: number[] } {
  const calls: Call[] = []
  const retries: Retrying[] = []
  const sleeps: number[] = []
  const deps: FetchDeps = {
    fetch: async (url, init) => {
      const headers = new Headers(init.headers)
      calls.push({ url, method: init.method ?? 'GET', range: headers.get('Range'), ifRange: headers.get('If-Range') })
      const answer = answers.shift()
      if (!answer) throw new Error(`no answer left for call ${calls.length}`)
      if (answer instanceof Error) throw answer
      return answer
    },
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    onRetry: (retrying) => retries.push(retrying),
  }
  return { deps, calls, retries, sleeps }
}

async function bytesOf(response: Response): Promise<number[]> {
  return [...new Uint8Array(await response.arrayBuffer())]
}

test('network failures and server errors are transient, everything the server refuses is permanent', () => {
  assert.equal(errorVerdict(new TypeError('Failed to fetch')), 'transient')
  assert.equal(errorVerdict(new DOMException('offline', 'NetworkError')), 'transient')
  assert.equal(errorVerdict(new DOMException('full', 'QuotaExceededError')), 'permanent')
  assert.equal(errorVerdict(new DOMException('stopped', 'AbortError')), 'permanent')
  assert.equal(statusVerdict(503), 'transient')
  assert.equal(statusVerdict(429), 'transient')
  assert.equal(statusVerdict(404), 'permanent')
  assert.equal(statusVerdict(403), 'permanent')
})

test('the delay doubles from a second and stops after the last attempt', () => {
  assert.deepEqual(
    Array.from({ length: FETCH_ATTEMPTS }, (_, i) => retryDelay(i + 1)),
    [1000, 2000, 4000, 8000, null],
  )
})

test('a failed request is retried with backoff until it answers', async () => {
  const { deps, calls, retries, sleeps } = harness([new TypeError('Failed to fetch'), new Response('', { status: 502 }), new Response(BYTES)])

  const response = await resilientFetch(URL_, {}, deps)

  assert.deepEqual(await bytesOf(response), [...BYTES])
  assert.equal(calls.length, 3)
  assert.deepEqual(sleeps, [1000, 2000])
  assert.deepEqual(
    retries.map((retry) => [retry.attempt, retry.attempts, retry.reason]),
    [
      [2, FETCH_ATTEMPTS, 'Failed to fetch'],
      [3, FETCH_ATTEMPTS, '502 '],
    ],
  )
})

test('a request that keeps failing gives up after the last attempt, naming the file', async () => {
  const { deps, calls } = harness(Array.from({ length: FETCH_ATTEMPTS }, () => new TypeError('Failed to fetch')))

  await assert.rejects(resilientFetch(URL_, {}, deps), /fetching \/speech\/model\.onnx failed, 5 times in a row: Failed to fetch/)
  assert.equal(calls.length, FETCH_ATTEMPTS)
})

test('a missing file is handed back at once for the caller to report', async () => {
  const { deps, calls, retries } = harness([new Response('', { status: 404 })])

  const response = await resilientFetch(URL_, {}, deps)

  assert.equal(response.status, 404)
  assert.equal(calls.length, 1)
  assert.equal(retries.length, 0)
})

test('a permanent failure such as a full disk fails at once', async () => {
  const { deps, calls } = harness([new DOMException('the quota is used up', 'QuotaExceededError')])

  await assert.rejects(resilientFetch(URL_, {}, deps), /fetching \/speech\/model\.onnx failed: the quota is used up/)
  assert.equal(calls.length, 1)
})

test('a download that breaks off resumes where it stopped, asking for the same version', async () => {
  const headers = { 'Content-Length': '10', ETag: '"v1"' }
  const { deps, calls, retries } = harness([
    brokenAfter(BYTES.subarray(0, 4), headers),
    new Response(BYTES.subarray(4), { status: 206, headers: { 'Content-Range': 'bytes 4-9/10', ETag: '"v1"' } }),
  ])

  const response = await resilientFetch(URL_, {}, deps)

  assert.deepEqual(await bytesOf(response), [...BYTES])
  assert.deepEqual(calls[1], { url: URL_, method: 'GET', range: 'bytes=4-', ifRange: '"v1"' })
  assert.equal(retries.length, 1)
})

test('a server that ignores the range is read from the start and the bytes already delivered are skipped', async () => {
  const headers = { 'Last-Modified': 'Mon, 09 Nov 2026 10:00:00 GMT' }
  const { deps } = harness([brokenAfter(BYTES.subarray(0, 3), headers), new Response(BYTES, { status: 200, headers })])

  const response = await resilientFetch(URL_, {}, deps)

  assert.deepEqual(await bytesOf(response), [...BYTES])
})

test('a file that changed on the server while downloading is not stitched together', async () => {
  const { deps } = harness([brokenAfter(BYTES.subarray(0, 3), { ETag: '"v1"' }), new Response(BYTES, { status: 200, headers: { ETag: '"v2"' } })])

  const response = await resilientFetch(URL_, {}, deps)

  await assert.rejects(response.arrayBuffer(), /changed on the server while it was downloading/)
})

test('the attempts are counted from the last progress, so a long download survives separate breaks', async () => {
  const headers = { ETag: '"v1"' }
  const resumed = (from: number, to: number, broken: boolean) => {
    const range = { 'Content-Range': `bytes ${from}-9/10`, ETag: '"v1"' }
    return broken ? brokenAfter(BYTES.subarray(from, to), range, 206) : new Response(BYTES.subarray(from), { status: 206, headers: range })
  }
  const answers: Answer[] = [brokenAfter(BYTES.subarray(0, 1), headers)]
  for (let at = 1; at < 9; at++) answers.push(resumed(at, at + 1, true))
  answers.push(resumed(9, 10, false))
  const { deps, retries } = harness(answers)

  const response = await resilientFetch(URL_, {}, deps)

  assert.deepEqual(await bytesOf(response), [...BYTES])
  assert.ok(retries.length > FETCH_ATTEMPTS)
  assert.ok(retries.every((retry) => retry.attempt === 2))
})

test('a download that keeps breaking without progress gives up', async () => {
  const headers = { ETag: '"v1"' }
  const answers: Answer[] = [brokenAfter(BYTES.subarray(0, 2), headers)]
  for (let i = 0; i < FETCH_ATTEMPTS; i++) answers.push(new TypeError('Failed to fetch'))
  const { deps } = harness(answers)

  const response = await resilientFetch(URL_, {}, deps)

  await assert.rejects(response.arrayBuffer(), /failed after 2 bytes, 5 times in a row/)
})

test('a response without a validator is not resumed, since another version could be stitched on', async () => {
  const { deps, calls } = harness([brokenAfter(BYTES.subarray(0, 2), {})])

  const response = await resilientFetch(URL_, {}, deps)

  await assert.rejects(response.arrayBuffer(), /broke off after 2 bytes: network error, and it cannot be resumed/)
  assert.equal(calls.length, 1)
})

test('only a plain whole-file GET is asked for with a HEAD first', () => {
  assert.equal(headFirst({}), true)
  assert.equal(headFirst({ method: 'get', headers: new Headers() }), true)
  assert.equal(headFirst({ method: 'HEAD' }), false)
  assert.equal(headFirst({ method: 'POST' }), false)
  assert.equal(headFirst({ headers: { Range: 'bytes=0-0' } }), false)
  assert.equal(headFirst({ headers: new Headers({ range: 'bytes=4-' }) }), false)
})

test('a size probe that never reads the body sends only a HEAD and still learns the size', async () => {
  const { deps, calls } = harness([new Response(null, { status: 200, headers: { 'Content-Length': '10', ETag: '"v1"' } })])

  const response = await headFirstFetch(URL_, {}, deps)

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Content-Length'), '10')
  assert.deepEqual(calls.map((call) => call.method), ['HEAD'])
})

test('reading the body downloads it with a GET after the HEAD', async () => {
  const { deps, calls } = harness([
    new Response(null, { status: 200, headers: { 'Content-Length': '10', ETag: '"v1"' } }),
    new Response(BYTES, { status: 200, headers: { 'Content-Length': '10', ETag: '"v1"' } }),
  ])

  const response = await headFirstFetch(URL_, {}, deps)

  assert.deepEqual(await bytesOf(response), [...BYTES])
  assert.deepEqual(calls.map((call) => call.method), ['HEAD', 'GET'])
})

test('a file the HEAD finds missing is handed back without a GET', async () => {
  const { deps, calls } = harness([new Response(null, { status: 404 })])

  const response = await headFirstFetch(URL_, {}, deps)

  assert.equal(response.status, 404)
  assert.deepEqual(calls.map((call) => call.method), ['HEAD'])
})

test('a file that changed between its HEAD and its download is refused', async () => {
  const { deps } = harness([
    new Response(null, { status: 200, headers: { 'Content-Length': '10', ETag: '"v1"' } }),
    new Response(BYTES, { status: 200, headers: { ETag: '"v2"' } }),
  ])

  const response = await headFirstFetch(URL_, {}, deps)

  await assert.rejects(response.arrayBuffer(), /changed on the server between its HEAD and its download/)
})

test('a download whose GET fails after the HEAD names the file and the status', async () => {
  const { deps } = harness([new Response(null, { status: 200 }), new Response('', { status: 403, statusText: 'Forbidden' })])

  const response = await headFirstFetch(URL_, {}, deps)

  await assert.rejects(response.arrayBuffer(), /fetching \/speech\/model\.onnx after its HEAD answered failed: 403 Forbidden/)
})

test('a ranged request goes out as it is, without a HEAD', async () => {
  const { deps, calls } = harness([new Response(BYTES.subarray(0, 1), { status: 206, headers: { 'Content-Range': 'bytes 0-0/10' } })])

  await headFirstFetch(URL_, { headers: { Range: 'bytes=0-0' } }, deps)

  assert.deepEqual(calls, [{ url: URL_, method: 'GET', range: 'bytes=0-0', ifRange: null }])
})
