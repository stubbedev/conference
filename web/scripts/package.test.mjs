import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

const ROOT = path.resolve(import.meta.dirname, '..')

// The scripts npm runs by their names alone around an install.
const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall', 'prepare']

test('dependencies are installed without running their install scripts', async () => {
  const settings = (await readFile(path.join(ROOT, '.npmrc'), 'utf8')).split('\n').map((line) => line.trim())

  assert.ok(settings.includes('ignore-scripts=true'), 'web/.npmrc no longer sets ignore-scripts=true')
})

test('no script counts on npm running it before or after another', async () => {
  const { scripts } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'))
  const names = Object.keys(scripts)

  const hooks = names.filter((name) => names.some((other) => name === `pre${other}` || name === `post${other}`))

  assert.deepEqual(
    [...hooks, ...INSTALL_HOOKS.filter((name) => names.includes(name))],
    [],
    'npm skips these while web/.npmrc sets ignore-scripts: call them from the script that needs them',
  )
})
