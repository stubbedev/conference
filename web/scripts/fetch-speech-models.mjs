// Writes the models.json the browser speech engines load from, so an
// operator sets up a model directory without knowing the ONNX file
// names: the models it chooses, and a manifest of every file a browser
// may ask for, in the layout transformers.js loads them from and with a
// Piper voice per language under piper/. Each file in the manifest names
// its repository, the commit to fetch it at, its size and, where the Hub
// gives one, its digest; the server fetches a file from the Hub the first
// time a browser asks for it and caches it. No model is downloaded here.
// The default models are pinned to a commit below, so the same run lists
// the same bytes twice; any other model is listed at the commit its
// repository is on, which the script names.
//
// The file list of each model comes from the Hugging Face API, and the
// voices come from piper-voices' voices.json. A voice with one speaker
// goes before one with several, whose speakers are anything from
// emotions to corpus ids and which speaks with its first unless they are
// named female and male, and medium goes before high, low and x_low.
//
// A model a browser without a usable GPU runs comes with its 8-bit
// export as well: the transcription fallback, or the transcription model
// itself when there is none, and every encoder-decoder translation model,
// which is also what a language model falls back to (m2m100 unless
// --mt-fallback says otherwise) on a browser that cannot run it. Every
// model also comes with whichever exports of the GPU ladder its repository
// has and a browser can hold, so a browser whose GPU refuses one can try
// the next.
//
// The default translator is TranslateGemma, a language model trained to
// translate between any two of its languages, for every pair without an
// OPUS-MT model of its own. Where an encoder-decoder model such as m2m100
// would translate such a pair instead, it goes through English when
// OPUS-MT has a model into and one out of it.
//
// Usage: node scripts/fetch-speech-models.mjs <target dir> [options]
//   --languages=en,de,da or all, the server's own list
//   --asr=owner/model --asr-dtype=q4f16
//   --asr-fallback=owner/model|none --asr-fallback-dtype=q4
//   --mt-kind=translator|seq2seq|llm --mt=owner/model --mt-dtype=q4f16
//   --mt-fallback=owner/model|none, what a language model falls back to
//   --pair-languages=en,de,da, all or none, every --languages by default
//   --pair-dtype=q4f16
//   --builtin

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { mtRoute, PIVOT, sharedRun } from '../src/lib/speech/models.ts'
import { CPU_DTYPE, GPU_LADDER } from '../src/lib/speech/runtime.ts'

const HUB = 'https://huggingface.co'
const HUB_ATTEMPTS = 4
const DEFAULT_RETRY_AFTER_S = 60
const MAX_RETRY_AFTER_S = 330
const LISTING_PAGE = 1000

const PINNED = {
  'onnx-community/whisper-large-v3-turbo': '360ebcde2559d60bb474678be3c1de9ef347d01a',
  'onnx-community/whisper-base': '27a07b4b52b3a4c5886134bb4320e93e1a4bbc7c',
  'onnx-community/moonshine-base-ONNX': 'b1e9b6aae3c3c7298f10c3798393fdf38e8fbbad',
  'Xenova/m2m100_418M': '9c374f0b7aca709787cea97b047bfbbd1559d177',
  'onnx-community/translategemma-text-4b-it-ONNX': 'f7874a1ac60758872a4f78aac0df95b17b776994',
  'onnx-community/Qwen2.5-1.5B-Instruct': 'd54957e3af1be04546436e874a60fe386041b244',
}

const LANGUAGES_FILE =
  process.env.LANGUAGES_FILE ?? path.resolve(import.meta.dirname, '..', '..', 'internal', 'speech', 'service', 'languages.json')

const MT_DEFAULTS = {
  translator: { model: 'onnx-community/translategemma-text-4b-it-ONNX', dtype: 'q4f16' },
  seq2seq: { model: 'Xenova/m2m100_418M', dtype: 'q4f16' },
  llm: { model: 'onnx-community/Qwen2.5-1.5B-Instruct', dtype: 'q4f16' },
}

const PIPER_REPO = 'rhasspy/piper-voices'
const PIPER_REVISION = 'e7229f7d33a10e145e109b886d661984201ac3c4'

const MODEL_FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
]

const ONNX_STEMS = {
  seq2seq: ['onnx/encoder_model', 'onnx/decoder_model_merged'],
  llm: ['onnx/model'],
  translator: ['onnx/model'],
}

const DTYPE_SUFFIXES = {
  fp32: '',
  fp16: '_fp16',
  q8: '_quantized',
  int8: '_int8',
  uint8: '_uint8',
  q4: '_q4',
  q4f16: '_q4f16',
  bnb4: '_bnb4',
  q2: '_q2',
  q2f16: '_q2f16',
  q1: '_q1',
  q1f16: '_q1f16',
}

const MAX_BROWSER_FILE = 2 ** 31 - 1
const MAX_BROWSER_EXPORT = 2 ** 32

const USAGE =
  'usage: node scripts/fetch-speech-models.mjs <target dir> [--languages=en,de,da] [--asr=owner/model] [--asr-dtype=q4f16] ' +
  '[--asr-fallback=owner/model|none] [--asr-fallback-dtype=q4] [--mt-kind=translator|seq2seq|llm] [--mt=owner/model] [--mt-dtype=q4f16] ' +
  '[--mt-fallback=owner/model|none] ' +
  '[--pair-languages=en,de,da|all] [--pair-dtype=q4f16] [--builtin]'

const VALUED = [
  'languages',
  'asr',
  'asr-dtype',
  'asr-fallback',
  'asr-fallback-dtype',
  'mt-kind',
  'mt',
  'mt-dtype',
  'mt-fallback',
  'pair-languages',
  'pair-dtype',
]
const FLAGS = ['builtin']

const PAIR_OWNERS = ['Xenova', 'onnx-community']

function codeList(option, value) {
  const codes = [...new Set(String(value).split(',').map((code) => code.trim()).filter(Boolean))]
  if (codes.length === 0) throw new Error(`--${option} names no language`)

  return codes
}

export function parseArgs(argv) {
  const options = {
    languages: 'en',
    asr: 'onnx-community/whisper-large-v3-turbo',
    'asr-dtype': 'q4f16',
    'asr-fallback': 'onnx-community/whisper-base',
    'asr-fallback-dtype': 'q4',
    'mt-kind': 'translator',
    'pair-dtype': 'q4f16',
    builtin: false,
  }
  const positional = []

  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      positional.push(arg)

      continue
    }

    const equals = arg.indexOf('=')
    const name = equals < 0 ? arg.slice(2) : arg.slice(2, equals)

    if (FLAGS.includes(name)) {
      if (equals >= 0) throw new Error(`--${name} takes no value; ${USAGE}`)
      options[name] = true

      continue
    }

    if (!VALUED.includes(name)) throw new Error(`${name} is not an option; ${USAGE}`)
    if (equals < 0) throw new Error(`--${name} needs a value, e.g. --${name}=...; ${USAGE}`)

    options[name] = arg.slice(equals + 1)
  }

  if (positional.length !== 1) throw new Error(`what to fill is missing; ${USAGE}`)

  const languages = codeList('languages', options.languages)

  const kind = options['mt-kind']
  if (!MT_DEFAULTS[kind]) throw new Error(`--mt-kind is ${kind}, not ${Object.keys(MT_DEFAULTS).join(' or ')}`)

  for (const option of ['asr-dtype', 'asr-fallback-dtype', 'mt-dtype', 'pair-dtype']) {
    const dtype = options[option]
    if (dtype !== undefined && DTYPE_SUFFIXES[dtype] === undefined) {
      throw new Error(`--${option} is ${dtype}, not one of ${Object.keys(DTYPE_SUFFIXES).join(', ')}`)
    }
  }

  return {
    dir: path.resolve(positional[0]),
    languages,
    asr: { model: options.asr, dtype: options['asr-dtype'] },
    fallback: options['asr-fallback'] === 'none' ? null : { model: options['asr-fallback'], dtype: options['asr-fallback-dtype'] },
    mt: {
      kind,
      model: options.mt ?? MT_DEFAULTS[kind].model,
      dtype: options['mt-dtype'] ?? MT_DEFAULTS[kind].dtype,
      fallback:
        kind !== 'seq2seq' && options['mt-fallback'] !== 'none'
          ? { model: options['mt-fallback'] ?? MT_DEFAULTS.seq2seq.model, dtype: MT_DEFAULTS.seq2seq.dtype }
          : null,
    },
    pairs: pairsFrom(options['pair-languages'], languages, options['pair-dtype']),
    builtin: options.builtin,
  }
}

function pairsFrom(named, languages, dtype) {
  if (named === 'none') return null
  if (named !== undefined) return { languages: codeList('pair-languages', named), dtype }
  return languages.length === 1 && languages[0] !== 'all' ? null : { languages, dtype }
}

export function retryAfterSeconds(header) {
  const seconds = Number.parseInt(header ?? '', 10)
  return Math.min(Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_RETRY_AFTER_S, MAX_RETRY_AFTER_S)
}

async function hubFetch(url, init = {}) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url, init)
    if (response.status !== 429 || attempt === HUB_ATTEMPTS) return response

    const seconds = retryAfterSeconds(response.headers.get('retry-after'))
    await response.body?.cancel()
    process.stderr.write(`${url} is rate limited; waiting ${seconds} s before attempt ${attempt + 1} of ${HUB_ATTEMPTS}\n`)
    await sleep(seconds * 1000)
  }
}

async function getJSON(url) {
  const response = await hubFetch(url)
  if (!response.ok) throw new Error(`cannot read ${url}: ${response.status} ${response.statusText}`)

  return response.json()
}

class MissingExport extends Error {}

async function languageCodes(asked) {
  const known = JSON.parse(await readFile(LANGUAGES_FILE, 'utf8')).map((language) => language.code)
  if (asked.length === 1 && asked[0] === 'all') return known

  const unknown = asked.filter((code) => !known.includes(code))
  if (unknown.length > 0) throw new Error(`${unknown.join(', ')} is not among the languages in ${LANGUAGES_FILE}: ${known.join(', ')}`)

  return asked
}

async function revisionOf(model) {
  const pinned = PINNED[model]
  if (pinned) return pinned

  const { sha } = await getJSON(`${HUB}/api/models/${model}`)
  process.stderr.write(`${model} is not pinned here; fetching it at ${sha}\n`)

  return sha
}

async function modelExists(model) {
  const response = await hubFetch(`${HUB}/api/models/${model}`, { method: 'HEAD' })
  if (response.status === 404 || response.status === 401) return false
  if (!response.ok) throw new Error(`cannot look up ${model}: ${response.status} ${response.statusText}`)

  return true
}

export function externalData(tree, name) {
  const shard = (index) => (index === 0 ? `${name}_data` : `${name}_data_${index}`)
  const shards = []
  for (let index = 0; tree.has(shard(index)); index++) shards.push(shard(index))
  return shards
}

function exportNames(tree, model, kind, dtype, revision, treeURL) {
  const names = []

  for (const stem of ONNX_STEMS[kind]) {
    const name = `${stem}${DTYPE_SUFFIXES[dtype]}.onnx`
    if (!tree.has(name)) throw new MissingExport(`${model} has no ${name} at ${revision}, so it has no ${dtype} export; ${treeURL}`)

    names.push(name, ...externalData(tree, name))
  }

  for (const name of names) {
    const { size } = tree.get(name)
    if (size > MAX_BROWSER_FILE) {
      throw new MissingExport(`${model} has ${name} of ${(size / 1e6).toFixed(0)} MB at ${revision}, larger than a browser can load as one file; choose another export or model`)
    }
  }

  const total = names.reduce((sum, name) => sum + tree.get(name).size, 0)
  if (total > MAX_BROWSER_EXPORT) {
    throw new MissingExport(`${model} has a ${dtype} export of ${(total / 1e6).toFixed(0)} MB at ${revision}, more than a browser can hold; choose another export or model`)
  }

  return names
}

// modelFiles is what one transformers.js model needs in each of the
// given exports, at the commit it is fetched at.
async function modelFiles(model, kind, dtypes) {
  const revision = await revisionOf(model)
  const treeURL = `${HUB}/api/models/${model}/tree/${revision}?recursive=true`

  return treeFiles(model, kind, dtypes, revision, await getJSON(treeURL), treeURL)
}

// treeFiles picks a model's files out of its repository's tree, the
// listing the Hub gives: the metadata, and the ONNX files of each given
// export and of whichever exports of the GPU ladder it has. Each file is
// served under the model's id, as transformers.js asks for it.
export function treeFiles(model, kind, dtypes, revision, listing, treeURL) {
  const tree = new Map(listing.filter((entry) => entry.type === 'file').map((entry) => [entry.path, entry]))

  if (!tree.has('config.json')) throw new Error(`${model} has no config.json at ${revision}: ${treeURL}`)
  const names = MODEL_FILES.filter((name) => tree.has(name))

  const required = new Set(dtypes)
  for (const dtype of new Set([...required, ...GPU_LADDER])) {
    try {
      names.push(...exportNames(tree, model, kind, dtype, revision, treeURL))
    } catch (err) {
      if (required.has(dtype) || !(err instanceof MissingExport)) throw err
    }
  }

  return names.map((name) => ({
    path: `${model}/${name}`,
    repo: model,
    revision,
    file: name,
    size: tree.get(name).size,
    ...(tree.get(name).lfs?.oid ? { sha256: tree.get(name).lfs.oid } : {}),
  }))
}

function exportsFor(dtype, cpu) {
  return cpu ? [dtype, CPU_DTYPE] : [dtype]
}

function moonshineCandidates(code) {
  if (code === 'en') return ['onnx-community/moonshine-base-ONNX']
  return [`onnx-community/moonshine-base-${code}-ONNX`, `onnx-community/moonshine-tiny-${code}-ONNX`]
}

async function listedModels(owner, search) {
  const ids = []
  let url = `${HUB}/api/models?author=${encodeURIComponent(owner)}&search=${encodeURIComponent(search)}&limit=${LISTING_PAGE}`

  while (url) {
    const response = await hubFetch(url)
    if (!response.ok) throw new Error(`cannot list the ${search} models of ${owner}: ${response.status} ${response.statusText} from ${url}`)

    ids.push(...(await response.json()).map((entry) => entry.id))
    url = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1] ?? null
  }

  return ids
}

async function moonshineFor(code, dtypes) {
  for (const model of moonshineCandidates(code)) {
    if (!(await modelExists(model))) continue

    try {
      return { model, files: await modelFiles(model, 'seq2seq', dtypes) }
    } catch (err) {
      if (!(err instanceof MissingExport)) throw err
      process.stderr.write(`skipping ${model}: ${err.message}\n`)
    }
  }

  return null
}

const ROMANCE_MODEL = 'Xenova/opus-mt-ROMANCE-en'
const ROMANCE_INTO_ENGLISH = ['ca', 'pt', 'ro']

export function planPairs(languages, hosted) {
  const found = []
  const skipped = []

  for (const source of languages) {
    for (const target of languages) {
      if (source === target) continue

      const pair = `${source}-${target}`
      const candidates = [...PAIR_OWNERS.map((owner) => `${owner}/opus-mt-${pair}`), ...(target === 'en' && ROMANCE_INTO_ENGLISH.includes(source) ? [ROMANCE_MODEL] : [])]
      const model = candidates.find((candidate) => hosted.has(candidate))

      if (model === undefined) {
        skipped.push({ pair, reason: `none of ${candidates.join(', ')} is on the hub` })
        continue
      }

      found.push({ pair, model })
    }
  }

  return { found, skipped }
}

async function pairModels(languages, dtype) {
  const listings = await Promise.all(PAIR_OWNERS.map((owner) => listedModels(owner, 'opus-mt-')))
  const { found, skipped } = planPairs(languages, new Set(listings.flat()))
  const pairs = []
  const files = []

  for (const entry of found) {
    try {
      files.push(...(await modelFiles(entry.model, 'seq2seq', exportsFor(dtype, true))))
      pairs.push(entry)
    } catch (err) {
      if (!(err instanceof MissingExport)) throw err
      skipped.push({ pair: entry.pair, reason: err.message })
    }
  }

  return { pairs, files, skipped }
}

const WITHOUT_GPU = { gpu: false, halves: false }

function withoutGpu(mt) {
  if (mt.kind === 'seq2seq') return `instead of ${mt.model}`
  return mt.fallback ? `on a browser that runs ${mt.fallback.model} instead of ${mt.model}` : `on a browser that cannot run ${mt.model}`
}

export function pairReport(mt, skipped, pairLanguages) {
  const shared = sharedRun(mt, WITHOUT_GPU, {}, null)
  const found = Object.entries(mt.pairs).map(([pair, { model }]) => `${pair}: ${model}`)
  const missing = skipped.map(({ pair, reason }) => {
    const [source, target] = pair.split('-')
    const route = mtRoute(mt.pairs, shared, source, target)
    if (route.kind !== 'pivot') return `warning: no OPUS-MT export for ${pair}, so ${mt.model} translates it: ${reason}`
    const through = `through ${route.via} with ${route.into.model} and ${route.out.model} ${withoutGpu(mt)}`
    return mt.kind === 'seq2seq'
      ? `${pair}: ${through}, since it has no OPUS-MT export of its own: ${reason}`
      : `warning: no OPUS-MT export for ${pair}, so ${mt.model} translates it, or ${through}: ${reason}`
  })
  const unpivoted =
    skipped.length > 0 && !pairLanguages.includes(PIVOT) ? [`warning: --pair-languages leaves out ${PIVOT}, so a pair without an OPUS-MT export cannot go through ${PIVOT} ${withoutGpu(mt)}`] : []
  return [...found, ...missing, ...unpivoted]
}

// QUALITIES is the order a voice is chosen in: a medium voice runs in
// real time in a browser, and a high one is bigger for little gain.
const QUALITIES = ['medium', 'high', 'low', 'x_low']

function rank(voice) {
  const quality = QUALITIES.indexOf(voice.quality)
  return quality === -1 ? QUALITIES.length : quality
}

// voiceFor picks the best voice of a language.
function voiceFor(code, voices) {
  const candidates = Object.values(voices)
    .filter((voice) => voice.language.family === code)
    .sort((a, b) => Number(a.num_speakers > 1) - Number(b.num_speakers > 1) || rank(a) - rank(b) || a.key.localeCompare(b.key))

  if (candidates.length === 0) {
    console.warn(`warning: ${PIPER_REPO} at ${PIPER_REVISION} has no voice for ${code}, so ${code} gets subtitles and no voice`)
    return null
  }

  return candidates[0]
}

// voiceFiles is a voice's model and the JSON beside it, as the repository
// names them, served from piper/ under the name the server and the
// browsers use.
export function voiceFiles(voice) {
  return ['.onnx', '.onnx.json'].map((suffix) => {
    const name = `${voice.key}${suffix}`
    const file = Object.entries(voice.files).find(([source]) => path.posix.basename(source) === name)
    if (!file) throw new Error(`${PIPER_REPO} has no ${name} for voice ${voice.key}`)

    const [source, { size_bytes: size, md5_digest: md5 }] = file

    return { path: `piper/${name}`, repo: PIPER_REPO, revision: PIPER_REVISION, file: source, size, ...(md5 ? { md5 } : {}) }
  })
}

// manifestOf is the files of models.json, by the path each is served
// at, in a stable order. Two models may list the same file, but never
// two different files at one path.
export function manifestOf(files) {
  const manifest = new Map()

  for (const { path: served, ...source } of files) {
    const listed = manifest.get(served)
    if (listed && JSON.stringify(listed) !== JSON.stringify(source)) {
      throw new Error(`${served} is listed twice, from ${JSON.stringify(listed)} and from ${JSON.stringify(source)}`)
    }

    manifest.set(served, source)
  }

  return Object.fromEntries([...manifest.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

function hubURL({ repo, revision, file }) {
  return `${HUB}/${repo}/resolve/${revision}/${file}`
}

async function hubText(manifest, served) {
  const file = manifest[served]
  if (!file) throw new Error(`${served} is not in the manifest`)

  const response = await hubFetch(hubURL(file))
  if (!response.ok) throw new Error(`cannot read ${hubURL(file)}: ${response.status} ${response.statusText}`)

  return response.text()
}

async function warnUntranslatable(manifest, model, languages, pairs) {
  const config = JSON.parse(await hubText(manifest, `${model}/config.json`))
  if (config.model_type !== 'm2m_100') return

  const tokenizer = await hubText(manifest, `${model}/tokenizer.json`)
  const missing = languages.filter((code) => !tokenizer.includes(`"__${code}__"`))
  for (const code of missing) {
    const covered = Object.keys(pairs).filter((pair) => pair.split('-').includes(code))
    console.warn(
      `warning: ${model} cannot translate ${code}${covered.length ? `, except with the pairs ${covered.join(', ')}` : ''}; --mt-kind=llm translates it`,
    )
  }
}

async function main() {
  const { dir, languages: asked, asr, fallback, mt, pairs: pairOption, builtin } = parseArgs(process.argv.slice(2))
  const languages = await languageCodes(asked)

  const pairLanguages = pairOption ? await languageCodes(pairOption.languages) : []
  const outside = pairLanguages.filter((code) => !languages.includes(code))
  if (outside.length > 0) throw new Error(`--pair-languages names ${outside.join(', ')}, which --languages does not: ${languages.join(', ')}`)
  if (pairOption && pairLanguages.length < 2) throw new Error(`--pair-languages names ${pairLanguages.join(', ')}, which makes no pair`)

  const fallbackLanguages = {}
  const paired = pairOption ? await pairModels(pairLanguages, pairOption.dtype) : { pairs: [], files: [], skipped: [] }
  const pairs = Object.fromEntries(paired.pairs.map(({ pair, model }) => [pair, { model, dtype: pairOption.dtype }]))

  const files = [
    ...(await modelFiles(asr.model, 'seq2seq', exportsFor(asr.dtype, fallback === null))),
    ...(await modelFiles(mt.model, mt.kind, exportsFor(mt.dtype, mt.kind === 'seq2seq'))),
  ]

  if (fallback) {
    files.push(...(await modelFiles(fallback.model, 'seq2seq', exportsFor(fallback.dtype, true))))
    for (const code of languages) {
      const moonshine = await moonshineFor(code, exportsFor(fallback.dtype, true))
      if (!moonshine) continue

      fallbackLanguages[code] = moonshine.model
      files.push(...moonshine.files)
    }
  }

  if (mt.fallback) files.push(...(await modelFiles(mt.fallback.model, 'seq2seq', exportsFor(mt.fallback.dtype, true))))

  files.push(...paired.files)

  const voices = await getJSON(`${HUB}/${PIPER_REPO}/resolve/${PIPER_REVISION}/voices.json`)
  const tts = {}

  for (const code of languages) {
    const voice = voiceFor(code, voices)
    if (!voice) continue

    tts[code] = voice.key
    files.push(...voiceFiles(voice))
  }

  const manifest = manifestOf(files)
  const listed = Object.values(manifest)
  const total = listed.reduce((sum, file) => sum + file.size, 0)

  const plain = mt.kind === 'seq2seq' ? mt.model : mt.fallback?.model
  if (plain) await warnUntranslatable(manifest, plain, languages, pairs)
  for (const line of pairReport({ ...mt, pairs }, paired.skipped, pairLanguages)) process.stderr.write(`${line}\n`)

  const choices = {
    asr: {
      model: asr.model,
      dtype: asr.dtype,
      ...(fallback ? { fallback: { ...fallback, languages: fallbackLanguages } } : {}),
    },
    mt: {
      kind: mt.kind,
      model: mt.model,
      dtype: mt.dtype,
      ...(mt.fallback ? { fallback: mt.fallback } : {}),
      ...(Object.keys(pairs).length > 0 ? { pairs } : {}),
      ...(builtin ? { builtin: true } : {}),
    },
    tts,
  }
  const modelsFile = path.join(dir, 'models.json')
  const partial = `${modelsFile}.part`
  await mkdir(dir, { recursive: true })
  await writeFile(partial, `${JSON.stringify({ ...choices, files: manifest }, null, 2)}\n`)
  await rename(partial, modelsFile)

  process.stdout.write(`${modelsFile}\n${JSON.stringify(choices, null, 2)}\n`)
  process.stderr.write(`${listed.length} files of ${(total / 1e6).toFixed(0)} MB in the manifest; the server fetches each from the Hub when a browser first asks for it\n`)
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`fetch-speech-models: ${err.message}\n`)
    process.exitCode = 1
  })
}
