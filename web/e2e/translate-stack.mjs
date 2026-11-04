// The local live-translation stack shared by translate-demo.mjs and
// translate-lan.mjs: the speech service, a freshly built meeting server
// with live translation turned on, and cleanup of everything started.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { freePort, sleep, stopProcess } from './browser.mjs'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const SPEECH_PORT = Number(process.env.SPEECH_PORT ?? 8090)

/** Processes to stop on exit, newest first. */
const started = []

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`)
}

// The server embeds web/dist, so the UI is built first.
export function buildServer(dir) {
  run('npm', ['run', 'build', '--silent'], join(repoRoot, 'web'))
  const bin = join(dir, 'server')
  run('go', ['build', '-o', bin, './cmd/server'], repoRoot)
  return bin
}

async function healthy(url) {
  try {
    return (await fetch(url)).ok
  } catch {
    return false
  }
}

export async function waitHealthy(url, what, seconds) {
  for (let i = 0; i < seconds * 5; i++) {
    if (await healthy(url)) return
    await sleep(200)
  }
  throw new Error(`${what} did not come up on ${url}`)
}

// KEY=value lines from speech/.env, where the OpenAI key is kept.
function speechEnvFile() {
  const path = join(repoRoot, 'speech/.env')
  if (!existsSync(path)) return {}
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )
}

// The models these demos use unless the environment names others; the
// speech service itself has no default model.
const DEMO_MODELS = {
  ollama: { TRANSLATE_MODEL: 'gemma4:26b-a4b-it-qat' },
  openai: { TRANSLATE_MODEL: 'gpt-4o-mini', TRANSCRIBE_MODEL: 'gpt-transcribe' },
}

/**
 * Starts the speech service unless one already answers on SPEECH_PORT
 * (which then must use the same secret). With openai, OpenAI translates
 * and transcribes, the key coming from speech/.env; testing only.
 */
export async function ensureSpeech({ secret, openai }) {
  const health = `http://127.0.0.1:${SPEECH_PORT}/healthz`
  if (await healthy(health)) {
    console.log(`speech service already running on :${SPEECH_PORT} (it must use SPEECH_SECRET=${secret})`)
    return
  }
  const python = join(repoRoot, 'speech/.venv/bin/python')
  if (!existsSync(python)) throw new Error('no speech venv: run `just speech-setup` first')
  const engines = openai
    ? { TRANSLATE_PROVIDER: 'openai-compatible', TRANSCRIBE_PROVIDER: 'openai-compatible', ...DEMO_MODELS.openai }
    : { TRANSLATE_PROVIDER: 'ollama', ...DEMO_MODELS.ollama }
  for (const name of Object.keys(engines)) if (process.env[name]) engines[name] = process.env[name]
  const fileEnv = openai ? speechEnvFile() : {}
  if (openai && !(process.env.OPENAI_API_KEY ?? fileEnv.OPENAI_API_KEY)) {
    throw new Error('put OPENAI_API_KEY=… in speech/.env (or the environment)')
  }
  if (!openai && !(process.env.TRANSLATE_URL ?? process.env.OLLAMA_URL)) {
    throw new Error('set TRANSLATE_URL (or OLLAMA_URL) to the Ollama endpoint that runs the translation model')
  }

  console.log(`starting the speech service with ${openai ? 'OpenAI' : `${engines.TRANSLATE_MODEL} on Ollama + local Whisper`}…`)
  track(
    spawn(python, ['-m', 'app'], {
      cwd: join(repoRoot, 'speech'),
      env: { ...fileEnv, ...process.env, ...engines, SPEECH_SECRET: secret, PORT: String(SPEECH_PORT) },
      stdio: 'inherit',
    }),
  )
  await waitHealthy(health, 'the speech service', 180)
}

/** Starts the built meeting server on loopback; returns its base URL. */
export async function startServer(bin, dir, { speechURL, secret, statusURL = '' }) {
  const port = await freePort()
  track(
    spawn(bin, [], {
      env: {
        ...process.env,
        PORT: String(port),
        BIND: '127.0.0.1',
        ICE_UDP_PORT: String(await freePort()),
        TURN_PORT: String(await freePort()),
        DB_PATH: join(dir, 'translate.db'),
        SPEECH_URL: speechURL,
        SPEECH_SECRET: secret,
        SPEECH_STATUS_URL: statusURL,
      },
      // SERVER_LOG=path keeps the meeting server's log for debugging.
      stdio: process.env.SERVER_LOG ? ['ignore', openSync(process.env.SERVER_LOG, 'a'), openSync(process.env.SERVER_LOG, 'a')] : 'ignore',
    }),
  )
  const base = `http://127.0.0.1:${port}`
  await waitHealthy(`${base}/api/config`, 'the meeting server', 10)
  return base
}

/** Registers something with a close() or a child process for cleanup. */
export function track(resource) {
  started.push(resource)
  return resource
}

/** Stops everything started, newest first, and exits. */
export async function shutdown(code) {
  for (const resource of started.reverse()) {
    if (typeof resource.close === 'function' && !('pid' in resource)) resource.close()
    else await stopProcess(resource)
  }
  process.exit(code)
}
