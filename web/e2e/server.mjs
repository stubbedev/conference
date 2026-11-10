// The server under test: built from this checkout, started on free ports
// with a scratch database, and stopped by the caller.
import { spawn, spawnSync } from 'node:child_process'
import { createSocket } from 'node:dgram'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { freePort, sleep } from './browser.mjs'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      out[key.slice(2)] = true
      continue
    }
    out[key.slice(2)] = value
    i++
  }
  return out
}

function freeUdpPort() {
  return new Promise((resolvePort, reject) => {
    const sock = createSocket('udp4')
    sock.on('error', reject)
    sock.bind(0, () => {
      const { port } = sock.address()
      sock.close(() => resolvePort(port))
    })
  })
}

// The race detector stops the server at the first data race a test
// provokes, at the price of a much slower forwarding loop; a test that
// measures media rates builds without it.
export function buildServer(dir, { race }) {
  const bin = join(dir, 'server')
  const res = spawnSync('go', ['build', ...(race ? ['-race'] : []), '-o', bin, './cmd/server'], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, CGO_ENABLED: race ? '1' : '0' },
  })
  if (res.status !== 0) throw new Error('go build failed')
  return bin
}

export async function serverEnv(dir, port) {
  return {
    ...process.env,
    PORT: String(port),
    ICE_UDP_PORT: String(await freeUdpPort()),
    TURN_PORT: String(await freePort()),
    DB_PATH: join(dir, 'smoke.db'),
    SPEECH_ENGINES: 'real',
    TRANSLATE_MODEL: '',
    GORACE: 'halt_on_error=1',
  }
}

export async function startServer(bin, env) {
  const port = env.PORT
  const proc = spawn(bin, [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proc.stdout.on('data', (d) => (log += d))
  proc.stderr.on('data', (d) => (log += d))
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/config`)
      if (res.ok) return { proc, log: () => log }
    } catch {
      // not up yet
    }
    await sleep(200)
  }
  proc.kill('SIGKILL')
  throw new Error(`server did not start:\n${log}`)
}
