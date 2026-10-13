#!/usr/bin/env node
// Production monitor: real calls against a live deployment, the same
// assertions as the smoke test. Two headless Chromes join a fresh room
// and must exchange E2EE audio and video directly, then forced through
// the TURN relay over UDP and TCP, then over TLS on 443 when the server
// offers it. Every room is created with an operator key and deleted
// afterwards, so a run leaves nothing behind. Exit code 0 means every
// call carried media both ways.
//
//   MONITOR_URL=https://meet.example.com MONITOR_API_KEY=... node web/e2e/monitor.mjs
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { check, checkCall, createRoom, evalJs, findChrome, joinRoom, launchChrome, sleep, stopProcess } from './browser.mjs'

const CALL_SECONDS = 8
const STAGGER_MS = 500

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set`)
  return value
}

const base = required('MONITOR_URL').replace(/\/+$/, '')
const apiKey = required('MONITOR_API_KEY')
const chrome = process.env.CHROME ?? findChrome()

const offeredURLs = `(window.__pcs[0]?.getConfiguration().iceServers ?? []).flatMap((s) => [].concat(s.urls))`

async function deleteRoom(slug) {
  const res = await fetch(`${base}/api/rooms/${slug}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (res.status !== 204) throw new Error(`delete room ${slug}: HTTP ${res.status} ${await res.text()}`)
}

// call places one two-browser call with the given relay transports
// and returns the ICE server URLs the server handed the first browser.
async function call(failures, dir, index, scenario) {
  const room = await createRoom(base, 'uptime-monitor', apiKey)
  const browsers = []
  try {
    for (const i of [0, 1]) browsers.push(await launchChrome(chrome, index * 2 + i, dir))
    await joinRoom(browsers[0], room.url, scenario.transports[0])
    await sleep(STAGGER_MS)
    await joinRoom(browsers[1], room.url, scenario.transports[1])
    console.log(`== ${scenario.name} (room ${room.slug})`)
    const labels = scenario.transports.map((t, i) => `${scenario.name} #${i}`)
    await checkCall(failures, browsers, labels, { seconds: CALL_SECONDS, wantPaths: scenario.want })
    return await evalJs(browsers[0], offeredURLs)
  } finally {
    await Promise.all(browsers.map((b) => stopProcess(b.proc, 'SIGKILL')))
    await deleteRoom(room.slug)
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'conference-monitor-'))
  const failures = []
  try {
    const urls = await call(failures, dir, 0, { name: 'direct', transports: [null, null], want: [] })
    check(failures, 'ice servers', urls.some((u) => u.startsWith('turn:')), `no TURN relay offered: ${urls.join(' ')}`)

    await call(failures, dir, 1, {
      name: 'turn udp+tcp',
      transports: ['udp', 'tcp'],
      want: ['relay/udp', 'relay/tcp'],
    })

    if (urls.some((u) => u.startsWith('turns:'))) {
      await call(failures, dir, 2, { name: 'turns 443', transports: ['tls', 'tls'], want: ['relay/tls', 'relay/tls'] })
    } else {
      console.log('== turns 443: the server offers no turns: URL (TURN_TLS_HOST unset), not checked')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }

  if (failures.length) {
    console.error(`\nMONITOR FAILED against ${base}`)
    for (const f of failures) console.error('  - ' + f)
    process.exitCode = 1
    return
  }
  console.log(`\nMONITOR OK: ${base} carries E2EE calls directly and through every TURN transport it offers`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
