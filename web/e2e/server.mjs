// The server under test: built from this checkout, started on free ports
// with a scratch database, and stopped by the caller.
import { spawn, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

export const NO_TRANSLATION = { SPEECH_ENGINES: 'real', TRANSLATE_MODEL: '' }

export function serverEnv(dir, settings = NO_TRANSLATION) {
  return {
    ...process.env,
    PORT: '0',
    ICE_UDP_PORT: '0',
    TURN_PORT: '0',
    DB_PATH: join(dir, 'server.db'),
    GORACE: 'halt_on_error=1',
    ...settings,
  }
}

const READY_LINE = /^ready (.*)$/m
const READY_TIMEOUT_MS = 30_000

export function startServer(bin, env) {
  const proc = spawn(bin, [], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  let stdout = ''
  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  return new Promise((resolveStart, reject) => {
    let settled = false
    const settle = () => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      return true
    }
    const fail = (reason) => {
      if (!settle()) return
      proc.kill('SIGKILL')
      reject(new Error(`server ${bin} ${reason}:\n${log}`))
    }
    const announced = (line) => {
      let ready
      try {
        ready = JSON.parse(line)
      } catch (err) {
        return fail(`printed an unreadable ready line ${JSON.stringify(line)}: ${err.message}`)
      }
      const port = Number(new URL(`http://${ready.http}`).port)
      if (!port) return fail(`announced no HTTP port in ${JSON.stringify(line)}`)
      if (settle()) resolveStart({ proc, log: () => log, ready, port, base: `http://127.0.0.1:${port}` })
    }
    const timer = setTimeout(() => fail(`printed no ready line within ${READY_TIMEOUT_MS / 1000} s`), READY_TIMEOUT_MS)
    proc.stderr.on('data', (d) => (log += d))
    proc.stdout.on('data', (d) => {
      log += d
      if (settled) return
      stdout += d
      const match = READY_LINE.exec(stdout)
      if (match && stdout.includes('\n', match.index)) announced(match[1])
    })
    proc.once('error', (err) => fail(`could not start: ${err.message}`))
    proc.once('exit', (code, signal) => fail(`exited (code ${code}, signal ${signal}) before it was ready`))
  })
}
