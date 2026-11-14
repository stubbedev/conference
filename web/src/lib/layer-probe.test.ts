import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LAYER_GRACE_MS, probeVerdict, simulcastAnswer } from './layer-probe.ts'

const RIDS = ['l', 'h']
const encoded = (...rids: string[]) => new Set(rids)

test('a browser that encodes both layers passes', () => {
  assert.equal(probeVerdict(encoded('l', 'h'), RIDS, 60), true)
})

test('a browser that encodes only the slow layer fails once the grace period is over', () => {
  assert.equal(probeVerdict(encoded('l'), RIDS, LAYER_GRACE_MS), false)
})

test('the probe waits while the layers are still starting', () => {
  assert.equal(probeVerdict(encoded(), RIDS, 0), undefined)
  assert.equal(probeVerdict(encoded('l'), RIDS, LAYER_GRACE_MS - 1), undefined)
  assert.equal(probeVerdict(encoded('h'), RIDS, 60), undefined)
})

const ANSWER = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 98', 'a=mid:0', 'a=recvonly', ''].join('\r\n')

test('the local answer accepts every rid as its own stream, as the SFU does', () => {
  assert.equal(
    simulcastAnswer(ANSWER, RIDS),
    ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 98', 'a=mid:0', 'a=rid:l recv', 'a=rid:h recv', 'a=simulcast:recv l;h', 'a=recvonly', ''].join('\r\n'),
  )
})

test('an answer that already has simulcast, or no media section, is left alone', () => {
  const withSimulcast = ANSWER.replace('a=recvonly', 'a=simulcast:recv l;h')
  assert.equal(simulcastAnswer(withSimulcast, RIDS), withSimulcast)
  assert.equal(simulcastAnswer('v=0\r\n', RIDS), 'v=0\r\n')
})
