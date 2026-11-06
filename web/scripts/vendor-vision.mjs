// Copies what background blur needs into web/public/vision, which is not
// committed: the runtime comes from the installed @mediapipe/tasks-vision
// package, and the segmentation model is a small Apache-2.0 file from
// MediaPipe's own model registry.

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'public', 'vision')
const WASM_OUT = path.join(OUT, 'wasm')
const PACKAGE_WASM = path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite'
const MODEL_SHA256 = '191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b'
const MODEL_FILE = path.join(OUT, 'selfie_segmenter.tflite')

const WASM_FILES = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm']

async function exists(file) {
  try {
    await stat(file)

    return true
  } catch {
    return false
  }
}

async function copyWasm() {
  for (const name of WASM_FILES) {
    const from = path.join(PACKAGE_WASM, name)
    if (!(await exists(from))) {
      throw new Error(`${from} is missing; run npm install in web/ first`)
    }

    await copyFile(from, path.join(WASM_OUT, name))
  }
}

async function downloadModel() {
  if (await exists(MODEL_FILE)) {
    const digest = createHash('sha256')
      .update(await readFile(MODEL_FILE))
      .digest('hex')
    if (digest === MODEL_SHA256) return
  }

  const response = await fetch(MODEL_URL)
  if (!response.ok) {
    throw new Error(`cannot download the segmentation model: ${response.status} from ${MODEL_URL}`)
  }

  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== MODEL_SHA256) {
    throw new Error(`the segmentation model from ${MODEL_URL} has sha256 ${digest}, expected ${MODEL_SHA256}`)
  }

  await writeFile(MODEL_FILE, bytes)
}

await mkdir(WASM_OUT, { recursive: true })
await copyWasm()
await downloadModel()
