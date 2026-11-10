import { errorMessage } from '../errors.ts'

export const FETCH_ATTEMPTS = 5

const FIRST_DELAY_MS = 1000

const MAX_DELAY_MS = 16_000

const OK = 200

const TRANSIENT_STATUSES = new Set([408, 425, 429])

const NETWORK_ERRORS = new Set(['NetworkError', 'TimeoutError'])

export type Verdict = 'transient' | 'permanent'

export interface Retrying {
  url: string
  attempt: number
  attempts: number
  delayMs: number
  reason: string
}

export interface FetchDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  sleep: (ms: number) => Promise<void>
  onRetry: (retrying: Retrying) => void
}

class TransientStatus extends Error {}

interface Opened {
  reader: ReadableStreamDefaultReader<Uint8Array>
  skip: number
}

export function statusVerdict(status: number): Verdict {
  return status >= 500 || TRANSIENT_STATUSES.has(status) ? 'transient' : 'permanent'
}

export function errorVerdict(err: unknown): Verdict {
  if (err instanceof TransientStatus || err instanceof TypeError) return 'transient'
  return err instanceof Error && NETWORK_ERRORS.has(err.name) ? 'transient' : 'permanent'
}

export function retryDelay(failures: number): number | null {
  if (failures < 1 || failures >= FETCH_ATTEMPTS) return null
  return Math.min(FIRST_DELAY_MS * 2 ** (failures - 1), MAX_DELAY_MS)
}

export function browserFetchDeps(onRetry: (retrying: Retrying) => void): FetchDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onRetry,
  }
}

export function resilientFetch(url: string, init: RequestInit, deps: FetchDeps): Promise<Response> {
  return new Download(url, init, deps).start()
}

export function headFirst(init: RequestInit): boolean {
  return (init.method ?? 'GET').toUpperCase() === 'GET' && !new Headers(init.headers).has('Range')
}

export async function headFirstFetch(url: string, init: RequestInit, deps: FetchDeps): Promise<Response> {
  if (!headFirst(init)) return resilientFetch(url, init, deps)

  const head = await resilientFetch(url, { ...init, method: 'HEAD' }, deps)
  if (head.status !== OK) return head

  const validator = head.headers.get('ETag') ?? head.headers.get('Last-Modified')
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  const body = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      reader ??= await openBody(url, init, deps, validator)
      const chunk = await reader.read()
      if (chunk.done) controller.close()
      else controller.enqueue(chunk.value)
    },
    cancel: (reason) => reader?.cancel(reason),
  }, { highWaterMark: 0 })
  return new Response(body, { status: head.status, statusText: head.statusText, headers: head.headers })
}

async function openBody(url: string, init: RequestInit, deps: FetchDeps, validator: string | null): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const response = await resilientFetch(url, init, deps)
  if (response.status !== OK || !response.body) {
    await response.body?.cancel()
    throw new Error(`fetching ${url} after its HEAD answered failed: ${response.status} ${response.statusText}`)
  }
  if (validator !== null && !carries(response, validator)) {
    await response.body.cancel()
    throw new Error(`${url} changed on the server between its HEAD and its download`)
  }
  return response.body.getReader()
}

export async function readBody(response: Response, onProgress: (loaded: number, total: number) => void): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) throw new Error(`${response.url || 'the response'} has no body to read`)
  const announced = Number(response.headers.get('Content-Length') ?? 0)
  const chunks: Uint8Array[] = []
  let loaded = 0
  for await (const chunk of response.body) {
    chunks.push(chunk)
    loaded += chunk.byteLength
    onProgress(loaded, Math.max(announced, loaded))
  }

  const bytes = new Uint8Array(loaded)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function resumeValidator(response: Response, init: RequestInit): string | null {
  if (new Headers(init.headers).has('Range')) return null
  const encoding = response.headers.get('Content-Encoding')
  if (encoding !== null && encoding !== 'identity') return null
  const etag = response.headers.get('ETag')
  if (etag !== null && !etag.startsWith('W/')) return etag
  return response.headers.get('Last-Modified')
}

function carries(response: Response, validator: string): boolean {
  return response.headers.get('ETag') === validator || response.headers.get('Last-Modified') === validator
}

class Download {
  private readonly url: string
  private readonly init: RequestInit
  private readonly deps: FetchDeps
  private failures = 0

  constructor(url: string, init: RequestInit, deps: FetchDeps) {
    this.url = url
    this.init = init
    this.deps = deps
  }

  async start(): Promise<Response> {
    for (;;) {
      try {
        const response = await this.deps.fetch(this.url, this.init)
        if (response.ok || statusVerdict(response.status) === 'permanent') return this.resuming(response)
        await response.body?.cancel()
        throw new TransientStatus(`${response.status} ${response.statusText}`)
      } catch (err) {
        await this.recover(err, 0)
      }
    }
  }

  private resuming(first: Response): Response {
    const validator = resumeValidator(first, this.init)
    if (!first.ok || !first.body) return first

    let opened: Opened = { reader: first.body.getReader(), skip: 0 }
    let delivered = 0

    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        for (;;) {
          let chunk: ReadableStreamReadResult<Uint8Array>
          try {
            chunk = await opened.reader.read()
          } catch (err) {
            if (validator === null) throw this.unresumable(err, delivered)
            await this.recover(err, delivered)
            opened = await this.reopen(validator, delivered)
            continue
          }
          if (chunk.done) {
            controller.close()
            return
          }
          const kept = chunk.value.subarray(Math.min(opened.skip, chunk.value.byteLength))
          opened.skip -= chunk.value.byteLength - kept.byteLength
          if (kept.byteLength === 0) continue
          delivered += kept.byteLength
          this.failures = 0
          controller.enqueue(kept)
          return
        }
      },
      cancel: (reason) => opened.reader.cancel(reason),
    })

    return new Response(body, { status: first.status, statusText: first.statusText, headers: first.headers })
  }

  private unresumable(err: unknown, delivered: number): Error {
    const reason = `${errorMessage(err)}, and it cannot be resumed without an ETag or Last-Modified to match`
    return new Error(`fetching ${this.url} broke off after ${delivered} bytes: ${reason}`, { cause: err })
  }

  private async reopen(validator: string, from: number): Promise<Opened> {
    for (;;) {
      try {
        return await this.resume(validator, from)
      } catch (err) {
        await this.recover(err, from)
      }
    }
  }

  private async resume(validator: string, from: number): Promise<Opened> {
    const headers = new Headers(this.init.headers)
    headers.set('Range', `bytes=${from}-`)
    headers.set('If-Range', validator)
    const response = await this.deps.fetch(this.url, { ...this.init, headers })

    if (response.status === 206 && response.body) {
      const range = response.headers.get('Content-Range') ?? ''
      if (range.startsWith(`bytes ${from}-`)) return { reader: response.body.getReader(), skip: 0 }
      await response.body.cancel()
      throw new Error(`resuming ${this.url} at byte ${from} returned the range "${range}"`)
    }
    if (response.status === 200 && response.body) {
      if (carries(response, validator)) return { reader: response.body.getReader(), skip: from }
      await response.body.cancel()
      throw new Error(`${this.url} changed on the server while it was downloading`)
    }
    await response.body?.cancel()
    const status = `${response.status} ${response.statusText}`
    if (statusVerdict(response.status) === 'transient') throw new TransientStatus(status)
    throw new Error(`resuming ${this.url} at byte ${from} failed: ${status}`)
  }

  private async recover(err: unknown, delivered: number): Promise<void> {
    const at = delivered > 0 ? ` after ${delivered} bytes` : ''
    if (errorVerdict(err) === 'permanent') throw new Error(`fetching ${this.url} failed${at}: ${errorMessage(err)}`, { cause: err })

    this.failures += 1
    const delayMs = retryDelay(this.failures)
    if (delayMs === null) {
      throw new Error(`fetching ${this.url} failed${at}, ${this.failures} times in a row: ${errorMessage(err)}`, { cause: err })
    }
    this.deps.onRetry({ url: this.url, attempt: this.failures + 1, attempts: FETCH_ATTEMPTS, delayMs, reason: errorMessage(err) })
    await this.deps.sleep(delayMs)
  }
}
