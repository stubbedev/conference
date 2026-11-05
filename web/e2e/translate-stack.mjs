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

// The engines these demos use unless the environment names others; the
// speech service itself has no default model. A local stack also needs
// the addresses of its transcription and voice servers, and a voice.
const DEMO_ENGINES = {
  openai: {
    TRANSLATE_PROVIDER: 'openai-compatible',
    TRANSLATE_MODEL: 'gpt-4o-mini',
    TRANSCRIBE_MODEL: 'gpt-transcribe',
    VOICE_MODEL: 'gpt-4o-mini-tts',
    VOICE_NAME: 'alloy',
  },
  local: { TRANSLATE_PROVIDER: 'ollama', TRANSLATE_MODEL: 'gemma4:26b-a4b-it-qat', TRANSCRIBE_MODEL: 'whisper' },
}
const LOCAL_SETTINGS = ['TRANSLATE_URL', 'TRANSCRIBE_URL', 'VOICE_URL', 'VOICE_MODEL', 'VOICE_NAME']

/**
 * Builds and starts the speech service unless one already answers on
 * SPEECH_PORT (which then must use the same secret). With openai, OpenAI
 * transcribes, translates and speaks, the key coming from speech/.env;
 * testing only. Otherwise Ollama translates and the environment names
 * the local transcription and voice servers.
 */
export async function ensureSpeech({ dir, secret, openai }) {
  const health = `http://127.0.0.1:${SPEECH_PORT}/healthz`
  if (await healthy(health)) {
    console.log(`speech service already running on :${SPEECH_PORT} (it must use the same SPEECH_SECRET as this run)`)
    return
  }
  const engines = { ...(openai ? DEMO_ENGINES.openai : DEMO_ENGINES.local) }
  for (const name of Object.keys(engines)) if (process.env[name]) engines[name] = process.env[name]
  const fileEnv = speechEnvFile()
  if (openai && !(process.env.OPENAI_API_KEY ?? fileEnv.OPENAI_API_KEY)) {
    throw new Error('put OPENAI_API_KEY=… in speech/.env (or the environment)')
  }
  const missing = openai ? [] : LOCAL_SETTINGS.filter((name) => !(process.env[name] ?? fileEnv[name]))
  if (missing.length > 0) {
    throw new Error(
      `set ${missing.join(', ')}: the local demo needs Ollama, a transcription server ` +
        "(e.g. whisper.cpp's whisper-server) and an OpenAI-compatible voice server",
    )
  }

  const bin = join(dir, 'speech')
  run('go', ['build', '-o', bin, './cmd/speech'], repoRoot)
  console.log(`starting the speech service with ${openai ? 'OpenAI' : 'your local engines'}…`)
  track(
    spawn(bin, [], {
      env: { ...fileEnv, ...process.env, ...engines, SPEECH_SECRET: secret, PORT: String(SPEECH_PORT) },
      stdio: 'inherit',
    }),
  )
  await waitHealthy(health, 'the speech service', 30)
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
