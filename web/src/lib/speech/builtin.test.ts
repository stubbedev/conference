import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { BuiltinTranslators } from './builtin.ts'

type Availability = 'unavailable' | 'downloadable' | 'downloading' | 'available'

const browser = globalThis as { Translator?: unknown }

function withTranslator(availability: () => Promise<Availability>, create: () => Promise<unknown>): void {
  browser.Translator = { availability, create }
}

function translators(): { builtin: BuiltinTranslators; warnings: string[] } {
  const warnings: string[] = []
  return { builtin: new BuiltinTranslators((warning) => warnings.push(warning)), warnings }
}

const ready = { translate: (text: string) => Promise.resolve(text) }

afterEach(() => {
  delete browser.Translator
})

test('a pair the browser can translate is used without a warning', async () => {
  withTranslator(() => Promise.resolve('available'), () => Promise.resolve(ready))
  const { builtin, warnings } = translators()

  assert.equal(await builtin.for('en', 'de'), ready)
  assert.deepEqual(warnings, [])
})

test('a browser without the translator API falls to the model without a warning', async () => {
  const { builtin, warnings } = translators()

  assert.equal(await builtin.for('en', 'de'), null)
  assert.deepEqual(warnings, [])
})

test('a pair reported as unavailable warns, naming the pair', async () => {
  withTranslator(() => Promise.resolve('unavailable'), () => Promise.resolve(ready))
  const { builtin, warnings } = translators()

  assert.equal(await builtin.for('en', 'da'), null)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /en into da/)
  assert.match(warnings[0], /reports this pair as unavailable/)
})

test('a refused creation warns with the reason the browser gave', async () => {
  withTranslator(() => Promise.resolve('downloadable'), () => Promise.reject(new Error('download declined')))
  const { builtin, warnings } = translators()

  assert.equal(await builtin.for('de', 'en'), null)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /de into en/)
  assert.match(warnings[0], /download declined/)
})

test('an availability check that throws warns with its reason', async () => {
  withTranslator(() => Promise.reject(new Error('blocked by policy')), () => Promise.resolve(ready))
  const { builtin, warnings } = translators()

  assert.equal(await builtin.for('en', 'de'), null)
  assert.match(warnings[0], /blocked by policy/)
})

test('a refused pair warns once however many sentences ask for it', async () => {
  withTranslator(() => Promise.resolve('unavailable'), () => Promise.resolve(ready))
  const { builtin, warnings } = translators()

  await builtin.for('en', 'de')
  await builtin.for('en', 'de')

  assert.equal(warnings.length, 1)
})

test('each refused pair gets its own warning', async () => {
  withTranslator(() => Promise.resolve('unavailable'), () => Promise.resolve(ready))
  const { builtin, warnings } = translators()

  await builtin.for('en', 'de')
  await builtin.for('de', 'en')

  assert.equal(warnings.length, 2)
})

test('a refusal is told again to a new preparation without asking the browser again', async () => {
  let asked = 0
  withTranslator(
    () => {
      asked += 1
      return Promise.resolve('unavailable')
    },
    () => Promise.resolve(ready),
  )
  const { builtin, warnings } = translators()

  await builtin.for('en', 'de')
  builtin.startPreparation()
  await builtin.for('en', 'de')

  assert.equal(warnings.length, 2)
  assert.equal(asked, 1)
})

test('a failed creation is tried again by a new preparation, and can then succeed', async () => {
  let attempts = 0
  withTranslator(
    () => Promise.resolve('downloadable'),
    () => {
      attempts += 1
      return attempts === 1 ? Promise.reject(new Error('download declined')) : Promise.resolve(ready)
    },
  )
  const { builtin, warnings } = translators()

  assert.equal(await builtin.for('en', 'de'), null)
  builtin.startPreparation()

  assert.equal(await builtin.for('en', 'de'), ready)
  assert.equal(attempts, 2)
  assert.equal(warnings.length, 1)
})

test('a failed creation is not tried again within one preparation', async () => {
  let attempts = 0
  withTranslator(
    () => Promise.resolve('downloadable'),
    () => {
      attempts += 1
      return Promise.reject(new Error('download declined'))
    },
  )
  const { builtin, warnings } = translators()

  await builtin.for('en', 'de')
  await builtin.for('en', 'de')

  assert.equal(attempts, 1)
  assert.equal(warnings.length, 1)
})
