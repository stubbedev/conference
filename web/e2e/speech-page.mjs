import { createReadStream, readdirSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appRoot = resolve(web, 'dist', 'app')
const fixtures = resolve(web, '..', 'fixtures')

const CONTENT_TYPES = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.wav': 'audio/wav',
  '.json': 'application/json',
  '.html': 'text/html',
}

export const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
}

function mounted(path, mounts) {
  for (const [prefix, root] of mounts) {
    if (!path.startsWith(prefix)) continue
    const file = resolve(root, path.slice(prefix.length))
    return file === root || file.startsWith(root + sep) ? file : null
  }
  return null
}

export function serveSpeechPage({ models } = {}) {
  const mounts = [['/fixtures/', fixtures], ...(models ? [['/speech/', resolve(models)]] : []), ['/', appRoot]]

  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      const file = mounted(decodeURIComponent((req.url ?? '/').split('?')[0]), mounts)
      if (!file) {
        res.writeHead(403).end()
        return
      }

      let target = file
      try {
        if (statSync(target).isDirectory()) target = join(target, 'index.html')
      } catch {
        res.writeHead(404).end()
        return
      }

      res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream', ...ISOLATION_HEADERS })
      createReadStream(target).pipe(res)
    })

    server.listen(0, '127.0.0.1', () =>
      resolveServer({ origin: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }),
    )
  })
}

export function builtWorker(name) {
  const assets = join(appRoot, 'assets')
  const file = readdirSync(assets).find((entry) => entry.startsWith(`${name}.worker-`) && entry.endsWith('.js'))
  if (!file) throw new Error(`no ${name} worker in ${assets}; run npm run build in web/ first`)
  return `/assets/${file}`
}

const readWav = `async (url) => {
  const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer())
  const view = new DataView(bytes.buffer)
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4))
    const length = view.getUint32(offset + 4, true)
    if (id === 'data') return new Int16Array(bytes.buffer.slice(offset + 8, offset + 8 + length))
    offset += 8 + length + (length % 2)
  }
  throw new Error('no data chunk in ' + url)
}`

const RUNTIME_PATHS = {
  mjs: '/ort/ort-wasm-simd-threaded.asyncify.mjs',
  wasm: '/ort/ort-wasm-simd-threaded.asyncify.wasm',
}

export function workerProbe(workers, body) {
  return `(async () => {
  const started = []
  const open = (url) => {
    const worker = new Worker(url, { type: 'module' })
    started.push(worker)
    const waiting = new Map()
    const events = []
    let next = 0
    worker.onmessage = (event) => {
      if (event.data.id === undefined) {
        events.push(event.data)
        return
      }
      const waiter = waiting.get(event.data.id)
      if (!waiter) return
      waiting.delete(event.data.id)
      if (event.data.type === 'error') waiter.reject(new Error(event.data.message))
      else waiter.resolve(event.data)
    }
    const ask = (message) => new Promise((resolve, reject) => {
      const id = next++
      waiting.set(id, { resolve, reject })
      worker.postMessage({ ...message, id })
    })
    return { ask, events, post: (message, transfer) => worker.postMessage(message, transfer ?? []) }
  }
  const workers = Object.fromEntries(Object.entries(${JSON.stringify(workers)}).map(([key, url]) => [key, open(url)]))
  const readWav = ${readWav}
  const fetchRuntime = async () => {
    const fetched = async (url) => {
      const response = await fetch(url)
      if (!response.ok) throw new Error('the speech runtime ' + url + ' could not be fetched: ' + response.status)
      return response
    }
    const [wasm, factory] = await Promise.all([
      fetched('${RUNTIME_PATHS.wasm}').then((response) => response.arrayBuffer()),
      fetched('${RUNTIME_PATHS.mjs}').then((response) => response.text()),
    ])
    return { wasm, factory }
  }
  try {
    return await (async () => { ${body} })()
  } catch (err) {
    return { error: String(err?.message ?? err) }
  } finally {
    for (const worker of started) worker.terminate()
  }
})()`
}
