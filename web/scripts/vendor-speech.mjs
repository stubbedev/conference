// Copies and downloads what the browser speech engines need into
// web/public, which is not committed: the ONNX Runtime WebAssembly files
// come from the installed onnxruntime-web package, Piper's phonemizer from
// @diffusionstudio/piper-wasm, and the Silero voice detection model from
// the project that publishes it. No CDN is involved at call time.
//
// Only the two backends the app asks for are copied: the wasm one, which
// runs a voice or a filter model, and the jsep one, which is WebGPU. Each
// needs its .mjs loader and the .wasm beside it. The phonemizer's .data
// file holds the eSpeak-NG language data and is served as it is.

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const ORT_OUT = path.join(ROOT, 'public', 'ort')
const PIPER_OUT = path.join(ROOT, 'public', 'piper')
const VAD_OUT = path.join(ROOT, 'public', 'vad')
const ORT_PACKAGE = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist')
const PIPER_PACKAGE = path.join(ROOT, 'node_modules', '@diffusionstudio', 'piper-wasm', 'build')

const ORT_FILES = ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']

const PIPER_FILES = ['piper_phonemize.js', 'piper_phonemize.wasm', 'piper_phonemize.data']

// Voice detection is the same model in every install, so the web UI ships
// it rather than asking whoever runs the server for a file.
const VAD_MODEL = {
  file: 'silero_vad.onnx',
  url: 'https://raw.githubusercontent.com/snakers4/silero-vad/v6.2.3/src/silero_vad/data/silero_vad.onnx',
  sha256: '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3',
}

async function exists(file) {
  try {
    await stat(file)

    return true
  } catch {
    return false
  }
}

async function copyFiles(packageDir, out, names) {
  for (const name of names) {
    const from = path.join(packageDir, name)
    if (!(await exists(from))) {
      throw new Error(`${from} is missing; run npm install in web/ first`)
    }

    await copyFile(from, path.join(out, name))
  }
}

const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function downloadModel({ file, url, sha256 }) {
  const target = path.join(VAD_OUT, file)
  if ((await exists(target)) && digestOf(await readFile(target)) === sha256) return

  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`cannot download ${file}: ${response.status} from ${url}`)
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = digestOf(bytes)
  if (digest !== sha256) {
    throw new Error(`${url} has sha256 ${digest}, expected ${sha256}`)
  }

  await writeFile(target, bytes)
}

await mkdir(ORT_OUT, { recursive: true })
await mkdir(PIPER_OUT, { recursive: true })
await mkdir(VAD_OUT, { recursive: true })
await copyFiles(ORT_PACKAGE, ORT_OUT, ORT_FILES)
await copyFiles(PIPER_PACKAGE, PIPER_OUT, PIPER_FILES)
await downloadModel(VAD_MODEL)
