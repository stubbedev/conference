// Voice detection for one speaker, in a worker of its own so a frame
// every 32 ms never waits behind a transcription. It answers how likely
// each 512-sample frame of 16 kHz audio is speech; the utterance cutting
// itself happens on the page (see vad.ts), which is also where the audio
// already is.

import { serve } from './serve'
import { Silero } from './silero'
import { modelURL } from './urls'
import { FRAME } from './vad'

/** The model's file name under the speech base path. */
const MODEL = 'silero_vad.onnx'

let silero: Silero | null = null

serve(async (request) => {
  switch (request.type) {
    case 'init': {
      silero = await Silero.load(modelURL(String(request.base), MODEL))
      return
    }

    case 'detect': {
      if (!silero) throw new Error('voice detection was asked before the model was loaded')

      const frame = request.frame as Int16Array
      if (frame.length !== FRAME) throw new Error(`voice detection reads ${FRAME} samples, not ${frame.length}`)

      return [{ probability: await silero.probability(frame) }]
    }

    default:
      throw new Error(`voice detection does not know "${request.type}"`)
  }
})
