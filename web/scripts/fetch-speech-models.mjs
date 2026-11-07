// Downloads the model files the browser speech engines load, so an
// operator can fill a model directory without knowing the ONNX file
// names: a Whisper model and a translation model in the layout
// transformers.js loads them from, and a Piper voice per language under
// piper/. Every repository is pinned to a commit below, so the same run
// downloads the same bytes twice.
//
// The file list of each model comes from the Hugging Face API, since a
// transformers.js model loads whatever metadata and ONNX exports its
// repository holds, and the voices come from piper-voices' voices.json.
// A voice speaks with one speaker, since a member chooses no speaker
// among the dozens of a multi-speaker voice, whose speakers are anything
// from emotions to corpus ids. A voice whose model card is CC0 or
// Apache-2.0 is preferred, medium
// before high, low and x_low. A language with only other licenses still
// gets a voice, with the license named, rather than no voice at all.
//
// Usage: node scripts/fetch-speech-models.mjs <target dir>
//   [--languages=en,de,da] [--asr=owner/model] [--mt=owner/model]
//   [--asr-dtype=q4f16] [--mt-dtype=q4]

import { createHash } from 'node:crypto'
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const HUB = 'https://huggingface.co'

const ASR_MODEL = 'onnx-community/whisper-large-v3-turbo'
const ASR_REVISION = '360ebcde2559d60bb474678be3c1de9ef347d01a'
const ASR_DTYPE = 'q4f16'

const MT_MODEL = 'Xenova/m2m100_418M'
const MT_REVISION = '9c374f0b7aca709787cea97b047bfbbd1559d177'
const MT_DTYPE = 'q4'

const PIPER_REPO = 'rhasspy/piper-voices'
const PIPER_REVISION = 'e7229f7d33a10e145e109b886d661984201ac3c4'

// What transformers.js reads from a model directory besides the exports.
const MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
]

// The exports transformers.js loads: one encoder, and one decoder with the
// past merged into it, each named with the dtype's suffix.
const ONNX_STEMS = ['onnx/encoder_model', 'onnx/decoder_model_merged']

const MAX_PARALLEL = 4
const REPORT_BYTES = 64e6

const USAGE = 'usage: node scripts/fetch-speech-models.mjs <target dir> [--languages=en,de,da] [--asr=owner/model] [--mt=owner/model] [--asr-dtype=q4f16] [--mt-dtype=q4]'

const OPTIONS = ['languages', 'asr', 'mt', 'asr-dtype', 'mt-dtype']

function parseArgs(argv) {
  const options = {
    languages: ['en'],
    asr: ASR_MODEL,
    mt: MT_MODEL,
    'asr-dtype': ASR_DTYPE,
    'mt-dtype': MT_DTYPE,
  }
  const positional = []

  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      positional.push(arg)

      continue
    }

    const equals = arg.indexOf('=')
    const name = equals < 0 ? arg.slice(2) : arg.slice(2, equals)
    if (!OPTIONS.includes(name)) throw new Error(`${name} is not an option; ${USAGE}`)
    if (equals < 0) throw new Error(`--${name} needs a value, e.g. --${name}=...; ${USAGE}`)

    options[name] = arg.slice(equals + 1)
  }

  if (positional.length !== 1) throw new Error(`what to fill is missing; ${USAGE}`)

  const languages = [...new Set(String(options.languages).split(',').map((code) => code.trim()).filter(Boolean))]
  if (languages.length === 0) throw new Error('--languages names no language')

  return { dir: path.resolve(positional[0]), languages, asr: options.asr, mt: options.mt, asrDtype: options['asr-dtype'], mtDtype: options['mt-dtype'] }
}

async function getJSON(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`cannot read ${url}: ${response.status} ${response.statusText}`)

  return response.json()
}

async function getText(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`cannot read ${url}: ${response.status} ${response.statusText}`)

  return response.text()
}

// modelFiles is what one transformers.js model needs, named as its
// repository holds it, and where each file goes in the model directory.
async function modelFiles(dir, model, revision, dtype) {
  const treeURL = `${HUB}/api/models/${model}/tree/${revision}?recursive=true`
  const entries = (await getJSON(treeURL)).filter((entry) => entry.type === 'file')
  const tree = new Map(entries.map((entry) => [entry.path, entry]))
  const suffix = dtype === 'fp32' ? '' : `_${dtype}`

  const names = MODEL_FILES.filter((name) => tree.has(name))
  if (!tree.has('config.json')) throw new Error(`${model} has no config.json at ${revision}: ${treeURL}`)

  for (const stem of ONNX_STEMS) {
    const name = `${stem}${suffix}.onnx`
    if (!tree.has(name)) {
      throw new Error(`${model} has no ${name} at ${revision}, so it has no ${dtype} export; ${treeURL}`)
    }

    names.push(name)

    // The weights of a large export can live in a file beside it.
    if (tree.has(`${name}_data`)) names.push(`${name}_data`)
  }

  return names.map((name) => ({
    url: `${HUB}/${model}/resolve/${revision}/${name}`,
    out: path.join(dir, ...model.split('/'), ...name.split('/')),
    size: tree.get(name).size,
    sha256: tree.get(name).lfs?.oid,
  }))
}

// cardURL is a voice's model card, which names the license of its data.
function cardURL(voice) {
  const card = Object.keys(voice.files).find((name) => path.posix.basename(name) === 'MODEL_CARD') ?? ''

  return `${HUB}/${PIPER_REPO}/resolve/${PIPER_REVISION}/${card}`
}

// permissive reports whether a voice's model card names CC0 or Apache-2.0
// as the license of the data it was trained on.
async function permissive(voice) {
  const card = Object.keys(voice.files).find((name) => path.posix.basename(name) === 'MODEL_CARD')
  if (!card) return false

  const url = cardURL(voice)
  const license = (await getText(url))
    .split('\n')
    .find((line) => /^\s*[*-]\s*license:/i.test(line))
  if (!license) return false

  const terms = license.slice(license.indexOf(':') + 1).trim().toLowerCase()

  return terms.startsWith('cc0') || terms.startsWith('apache') ||
    terms.includes('license-2.0') || terms.includes('publicdomain/zero')
}

// QUALITIES is the order a voice is chosen in: a medium voice runs in
// real time in a browser, and a high one is bigger for little gain.
const QUALITIES = ['medium', 'high', 'low', 'x_low']

function rank(voice) {
  const quality = QUALITIES.indexOf(voice.quality)
  return quality === -1 ? QUALITIES.length : quality
}

// voiceFor picks a voice of a language: the best one whose model card is
// permissive, and otherwise the best one there is, saying whose license
// it carries.
async function voiceFor(code, voices) {
  const candidates = Object.values(voices)
    .filter((voice) => voice.language.family === code && voice.num_speakers === 1)
    .sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key))

  if (candidates.length === 0) {
    throw new Error(`${PIPER_REPO} at ${PIPER_REVISION} has no voice for ${code}`)
  }

  for (const candidate of candidates) {
    if (await permissive(candidate)) return candidate
  }

  const voice = candidates[0]
  console.warn(`warning: ${code} has no CC0 or Apache-2.0 voice; ${voice.key} carries the license its model card names, so read ${cardURL(voice)} before shipping it`)

  return voice
}

// voiceFiles is a voice's model and the JSON beside it, as the repository
// names them, into piper/ under the name the server and the browsers use.
function voiceFiles(dir, voice) {
  return ['.onnx', '.onnx.json'].map((suffix) => {
    const name = `${voice.key}${suffix}`
    const file = Object.entries(voice.files).find(([source]) => path.posix.basename(source) === name)
    if (!file) throw new Error(`${PIPER_REPO} has no ${name} for voice ${voice.key}`)

    const [source, { size_bytes: size, md5_digest: md5 }] = file

    return {
      url: `${HUB}/${PIPER_REPO}/resolve/${PIPER_REVISION}/${source}`,
      out: path.join(dir, 'piper', name),
      size,
      md5,
    }
  })
}

async function sizeOf(file) {
  try {
    const info = await stat(file)

    return info.isFile() ? info.size : -1
  } catch {
    return -1
  }
}

function sizeLabel(bytes) {
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`

  return bytes >= 1e3 ? `${(bytes / 1e3).toFixed(0)} kB` : `${bytes} B`
}

// download streams a file to a temporary name beside it and renames it
// into place, so a file that is there is a file that is whole.
async function download(file) {
  const name = path.basename(file.out)
  const size = sizeLabel(file.size)

  if ((await sizeOf(file.out)) === file.size) {
    process.stderr.write(`${file.out} is already there, ${size}\n`)

    return
  }

  await mkdir(path.dirname(file.out), { recursive: true })

  const response = await fetch(file.url)
  if (!response.ok) throw new Error(`cannot download ${file.out}: ${response.status} from ${file.url}, wanted ${size}`)

  const partial = `${file.out}.part`
  const handle = await open(partial, 'w')
  const hash = createHash(file.sha256 ? 'sha256' : 'md5')
  let written = 0
  let reported = 0

  try {
    for await (const chunk of response.body) {
      await handle.write(chunk)
      hash.update(chunk)
      written += chunk.length

      if (written - reported >= REPORT_BYTES) {
        reported = written
        process.stderr.write(`${(written / 1e6).toFixed(1)} MB of ${size} ${name}\n`)
      }
    }
  } finally {
    await handle.close()
  }

  if (written !== file.size) {
    await rm(partial, { force: true })
    throw new Error(`${file.url} sent ${sizeLabel(written)}, wanted ${size} in ${file.out}`)
  }

  const digest = hash.digest('hex')
  const expected = file.sha256 ?? file.md5
  if (expected && digest !== expected) {
    await rm(partial, { force: true })
    throw new Error(`${file.url} has ${file.sha256 ? 'sha256' : 'md5'} ${digest}, expected ${expected}`)
  }

  await rename(partial, file.out)
  process.stderr.write(`${size} ${name} done\n`)
}

async function downloadAll(files) {
  const queue = [...files]
  const workers = Array.from({ length: Math.min(MAX_PARALLEL, queue.length) }, async () => {
    while (queue.length > 0) await download(queue.shift())
  })

  await Promise.all(workers)
}

async function main() {
  const { dir, languages, asr, mt, asrDtype, mtDtype } = parseArgs(process.argv.slice(2))

  const voices = await getJSON(`${HUB}/${PIPER_REPO}/resolve/${PIPER_REVISION}/voices.json`)
  const tts = {}
  const files = [
    ...(await modelFiles(dir, asr, ASR_REVISION, asrDtype)),
    ...(await modelFiles(dir, mt, MT_REVISION, mtDtype)),
  ]

  for (const code of languages) {
    const voice = await voiceFor(code, voices)
    tts[code] = voice.key
    files.push(...voiceFiles(dir, voice))
  }

  const unique = [...new Map(files.map((file) => [file.out, file])).values()]
  const total = unique.reduce((sum, file) => sum + file.size, 0)
  process.stderr.write(`${unique.length} files, ${(total / 1e6).toFixed(0)} MB, into ${dir}\n`)

  await downloadAll(unique)

  const models = {
    asr: { model: asr, dtype: asrDtype },
    mt: { model: mt, dtype: mtDtype },
    tts,
  }
  const text = `${JSON.stringify(models, null, 2)}\n`
  const modelsFile = path.join(dir, 'models.json')
  await writeFile(modelsFile, text)

  process.stdout.write(`${modelsFile}\n${text}`)
  process.stderr.write(`total ${(total / 1e6).toFixed(0)} MB in ${unique.length} files in ${dir}\n`)
}

main().catch((err) => {
  process.stderr.write(`fetch-speech-models: ${err.message}\n`)
  process.exitCode = 1
})
