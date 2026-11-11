// The local live-translation stack shared by translate-demo.mjs and
// translate-lan.mjs: a freshly built meeting server whose speech service
// runs on the chosen engines, and cleanup of everything started.
import { spawnSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { join } from 'node:path'

import { stopProcess } from './browser.mjs'
import { buildServer as buildGoServer, repoRoot, serverEnv, startServer as startGoServer } from './server.mjs'

export { repoRoot }

/** Processes to stop on exit, newest first. */
const started = []

function run(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd, stdio: 'inherit' })
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`)
}

// The server embeds web/dist, so the UI is built first.
export function buildServer(dir) {
  run('npm', ['run', 'build', '--silent'], join(repoRoot, 'web'))
  return buildGoServer(dir, { race: false })
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
  const server = await startGoServer(bin, serverEnv(dir, { BIND: '127.0.0.1', ...engines }))
  if (process.env.SERVER_LOG) {
    const out = track(createWriteStream(process.env.SERVER_LOG, { flags: 'a' }))
    out.write(server.log())
    server.proc.stdout.pipe(out, { end: false })
    server.proc.stderr.pipe(out, { end: false })
  }
  track(server.proc)
  return server.base
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
