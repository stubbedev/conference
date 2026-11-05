// The local live-translation stack shared by translate-demo.mjs and
// translate-lan.mjs: a freshly built meeting server whose speech service
// runs on the chosen engines, and cleanup of everything started.
import { spawn, spawnSync } from 'node:child_process'
import { openSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { freePort, sleep, stopProcess } from './browser.mjs'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

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
 * The speech engine settings for the meeting server. With openai, OpenAI
 * transcribes, translates and speaks, the key coming from OPENAI_API_KEY;
 * testing only. Otherwise Ollama translates and the environment names
 * the local transcription and voice servers.
 */
export function speechEngines(openai) {
  const engines = { ...(openai ? DEMO_ENGINES.openai : DEMO_ENGINES.local) }
  for (const name of Object.keys(engines)) if (process.env[name]) engines[name] = process.env[name]
  if (openai && !process.env.OPENAI_API_KEY) throw new Error('set OPENAI_API_KEY')
  const missing = openai ? [] : LOCAL_SETTINGS.filter((name) => !process.env[name])
  if (missing.length > 0) {
    throw new Error(
      `set ${missing.join(', ')}: the local demo needs Ollama, a transcription server ` +
        "(e.g. whisper.cpp's whisper-server) and an OpenAI-compatible voice server",
    )
  }
  return engines
}

/** Starts the built meeting server on loopback with these speech engines; returns its base URL. */
export async function startServer(bin, dir, engines) {
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
        ...engines,
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
