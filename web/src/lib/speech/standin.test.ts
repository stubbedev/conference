import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RATE } from './vad.ts'
import { StandInEngines, standInTone, standInTranscript, standInTranslation } from './standin.ts'

test('a stand-in transcript is numbered and in the speaker\'s language', async () => {
  const engines = new StandInEngines()
  const asr = await engines.asr('de')

  assert.equal(await asr.transcribe(new Int16Array(0), 'de'), 'de utterance 1')
  assert.equal(await asr.transcribe(new Int16Array(0), 'de'), 'de utterance 2')
})

test('a stand-in translation names the target language', async () => {
  const engines = new StandInEngines()
  const mt = await engines.mt('en', 'de')

  assert.equal(await mt.translate({ text: 'hello', source: 'en', target: 'de', earlier: [] }), '[de] hello')
  assert.equal(standInTranslation('en', standInTranscript('de', 1)), '[en] de utterance 1')
})

test('a stand-in voice is a tone at the capture rate', async () => {
  const engines = new StandInEngines()
  const tts = await engines.tts('en')
  const voiced = await tts.speak('hello', 'en', 'female')

  assert.equal(voiced.rate, RATE)
  assert.equal(voiced.pcm.length, standInTone().pcm.length)
  assert.ok(voiced.pcm.some((sample) => sample !== 0))
})

test('stand-in engines need no WebGPU', async () => {
  assert.equal(new StandInEngines().requiresWebGpu, false)
})

test('the stand-in segmenter cuts loud audio into an utterance, and flushes the one in progress', async () => {
  const segments: string[] = []
  const engines = new StandInEngines()
  const segmenter = await engines.segmenter({
    onSegment: (segment) => segments.push(segment.kind),
    onError: (error) => assert.fail(error),
  })

  segmenter.push(new Int16Array(RATE).fill(8000))
  segmenter.flush()
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(segments.at(-1), 'utterance')
  assert.ok(segments.includes('partial'))
})
