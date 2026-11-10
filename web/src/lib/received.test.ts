import assert from 'node:assert/strict'
import { test } from 'node:test'

import { unreceived, type Negotiated } from './received.ts'

const section = (mid: string | null, currentDirection: RTCRtpTransceiverDirection | null): Negotiated => ({ mid, currentDirection })

const tracks = new Map([
  ['0', 'microphone'],
  ['1', 'camera'],
  ['2', 'translated voice'],
])

test('every track is still received while its section is', () => {
  assert.deepEqual(unreceived(tracks, [section('0', 'recvonly'), section('1', 'sendrecv'), section('2', 'recvonly')]), [])
})

test('a track is gone once the server has renegotiated its section to inactive', () => {
  const negotiated = [section('0', 'recvonly'), section('1', 'recvonly'), section('2', 'inactive')]
  assert.deepEqual(unreceived(tracks, negotiated), [['2', 'translated voice']])
})

test('a section that only sends, was stopped or was never negotiated receives nothing', () => {
  const negotiated = [section('0', 'sendonly'), section('1', 'stopped'), section('2', null)]
  assert.deepEqual(unreceived(tracks, negotiated), [...tracks])
})

test('a track whose section the connection no longer has is gone', () => {
  assert.deepEqual(unreceived(tracks, [section('0', 'recvonly'), section(null, 'recvonly')]), [
    ['1', 'camera'],
    ['2', 'translated voice'],
  ])
})

test('a section that receives a track nobody was handed takes nothing away', () => {
  assert.deepEqual(unreceived(new Map<string, string>(), [section('0', 'recvonly'), section('1', 'inactive')]), [])
})
