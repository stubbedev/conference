// The translated voice, in a worker of its own: one sentence, spoken by a
// Piper voice for a listener's language, as mono PCM the page plays. A
// language the server has no voice for is an error naming the language,
// not a silence the member has to guess about.

import { Piper } from './piper'
import { serve } from './serve'
import { isVoiceChoice, type VoiceChoice } from '../translate/types'

let piper: Piper | null = null
let voices: Record<string, string> = {}

serve(async (request) => {
  switch (request.type) {
    case 'init': {
      voices = (request.voices ?? {}) as Record<string, string>
      piper = new Piper(String(request.base))
      return
    }

    case 'speak': {
      if (!piper) throw new Error('the voice was asked to speak before it was loaded')

      const lang = String(request.lang)
      const voice = voices[lang]
      if (!voice) throw new Error(`there is no voice for ${lang}`)

      const choice: VoiceChoice = isVoiceChoice(request.voice) ? request.voice : 'female'
      const spoken = await piper.speak(String(request.text), voice, choice)

      return [{ pcm: spoken.pcm, rate: spoken.rate }, [spoken.pcm.buffer]]
    }

    default:
      throw new Error(`the voice does not know "${request.type}"`)
  }
})
