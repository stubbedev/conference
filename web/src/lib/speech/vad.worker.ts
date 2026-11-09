import { fetchRetrying } from './loading'
import { configureOrt } from './ort'
import { notify, serve } from './serve'
import { Silero } from './silero'
import { modelURL } from './urls'
import { FRAME, Segmentation, type Segment } from './vad'
import { parseRuntime } from './wasm'

const MODEL = 'silero_vad.onnx'

let silero: Silero | null = null
const segmentation = new Segmentation()

function loaded(): Silero {
  if (!silero) throw new Error('voice detection was asked before the model was loaded')
  return silero
}

async function loadSilero(url: string): Promise<Silero> {
  const response = await fetchRetrying(url)
  if (!response.ok) throw new Error(`the voice detection model ${url} could not be fetched: ${response.status} ${response.statusText}`)
  return Silero.load(url, new Uint8Array(await response.arrayBuffer()))
}

function report(segments: readonly (Segment | null)[]): void {
  for (const segment of segments) {
    if (segment) notify('segment', { kind: segment.kind, audio: segment.audio }, [segment.audio.buffer])
  }
}

serve(async (request) => {
  switch (request.type) {
    case 'init': {
      configureOrt('detector', parseRuntime(request.runtime))
      silero ??= await loadSilero(modelURL(String(request.base), MODEL))
      return
    }

    case 'audio': {
      const model = loaded()
      report(await segmentation.push(request.pcm as Int16Array, (frame) => model.probability(frame)))
      return
    }

    case 'flush':
      report([segmentation.flush()])
      return

    case 'reset':
      segmentation.reset()
      return

    case 'detect': {
      const frame = request.frame as Int16Array
      if (frame.length !== FRAME) throw new Error(`voice detection reads ${FRAME} samples, not ${frame.length}`)
      return [{ probability: await loaded().probability(frame) }]
    }

    default:
      throw new Error(`voice detection does not know "${request.type}"`)
  }
})
