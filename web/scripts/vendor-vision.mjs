// Copies what background blur needs into web/public/vision, which is not
// committed: the runtime comes from the installed @mediapipe/tasks-vision
// package, and the segmentation models are small Apache-2.0 files from
// MediaPipe's own model registry.
//
// There are two models because the input shape is fixed at build time in
// the model: the landscape one takes a 256x144 picture, which is exactly
// the shape of a phone held sideways or a laptop camera, and a person
// squeezed from 16:9 into a square is a person the model segments worse.
// Portrait cameras get the square one.

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.join(ROOT, 'public', 'vision')
const WASM_OUT = path.join(OUT, 'wasm')
const PACKAGE_WASM = path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')

const REGISTRY = 'https://storage.googleapis.com/mediapipe-models/image_segmenter'

const MODELS = [
  {
    file: 'selfie_segmenter_landscape.tflite',
    url: `${REGISTRY}/selfie_segmenter_landscape/float16/1/selfie_segmenter_landscape.tflite`,
    sha256: '490e9ea734313e0de10fa0cd9e3c6133e36ea4db2b7a49bde9ef019f72796b8e',
  },
  {
    file: 'selfie_segmenter.tflite',
    url: `${REGISTRY}/selfie_segmenter/float16/1/selfie_segmenter.tflite`,
    sha256: '191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b',
  },
]

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

const digestOf = (bytes) => createHash('sha256').update(bytes).digest('hex')

async function downloadModel({ file, url, sha256 }) {
  const target = path.join(OUT, file)
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

await mkdir(WASM_OUT, { recursive: true })
await copyWasm()
for (const model of MODELS) await downloadModel(model)
