// A shared screen as the tests see it: a stand-in for the screen picker,
// which headless browsers do not have, and the counters both ends of a
// share expose.
import { accessibleName, callJs, sleep } from './browser.mjs'

// A control is a button on the bar or an item in its "More options"
// menu, which Radix opens on pointerdown rather than click.
function clickButtonByLabel(label) {
  const find = () => [...document.querySelectorAll('button, [role="menuitem"]')].find((b) => accessibleName(b) === label)
  let control = find()
  if (!control) {
    const more = document.querySelector('button[aria-label="More options"]')
    if (!more || more.getAttribute('aria-expanded') === 'true') return false
    more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
    control = find()
  }
  if (!control) {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return false
  }
  control.click()
  return true
}

export async function clickButtonByTitle(browser, label) {
  for (let t = 0; t < 20; t++) {
    const clicked = await callJs(browser, clickButtonByLabel, label)
    if (clicked) return true
    await sleep(250)
  }
  return false
}

export const SHARE_WIDTH = 1600
export const SHARE_HEIGHT = 900

// What the stand-in screen shows, set with shareMode: a page of text whose
// counters tick every frame, the page scrolling fast, or nothing changing.
export const SHARE_MODES = ['typing', 'scrolling', 'still']

export const shareMode = (mode) => {
  if (!SHARE_MODES.includes(mode)) throw new Error(`unknown share mode ${mode}`)
  return `window.__shareMode = ${JSON.stringify(mode)}`
}

const SCROLL_PX_PER_FRAME = 12

// How long the stand-in keeps delivering its picture after the capture
// starts, however still: the call has to attach an encoder before a frame
// can reach anyone, and a frame delivered before that is lost.
const CAPTURE_START_MS = 2000

// The share is a canvas handed out where getDisplayMedia would hand out a
// screen; everything after the picker is the call's own path. Like a
// screen it shows a picture from the start, whatever the mode; a still
// one repeats the same picture until CAPTURE_START_MS has passed.
export const fakeDisplay = `(() => {
  window.__shareMode = 'typing'
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas')
    canvas.width = ${SHARE_WIDTH}
    canvas.height = ${SHARE_HEIGHT}
    const ctx = canvas.getContext('2d')
    const lineHeight = 18
    const words = ['the', 'quick', 'brown', 'fox', 'jumps', 'over', 'lazy', 'dog', 'packet', 'frame', 'estimate', 'scroll']
    const text = (index) => Array.from({ length: 14 }, (_, k) => words[(index * 7 + k * 5 + ((index * k) % 11)) % words.length]).join(' ')
    let frame = 0
    let offset = 0
    const draw = () => {
      const mode = window.__shareMode
      if (mode === 'still' && performance.now() - startedAt > ${CAPTURE_START_MS}) return
      if (mode === 'scrolling') offset += ${SCROLL_PX_PER_FRAME}
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = '#000'
      ctx.font = '14px monospace'
      const first = Math.floor(offset / lineHeight)
      for (let line = 0; line <= canvas.height / lineHeight; line++) {
        const index = first + line
        const y = line * lineHeight - (offset % lineHeight) + lineHeight
        ctx.fillText('line ' + index + ' frame ' + frame + ' ' + text(index), 10, y)
      }
      if (mode !== 'still') frame++
    }
    const startedAt = performance.now()
    setInterval(draw, 16)
    return canvas.captureStream(60)
  }
  return true
})()`

const sharePeerConnection = `window.__pcs.find((pc) => pc.signalingState !== 'closed' && pc.getTransceivers().some((t) => t.sender.track?.contentHint === 'detail'))`

export const screenSent = `
(async () => {
  const pc = ${sharePeerConnection}
  if (!pc) return null
  const mid = pc.getTransceivers().find((t) => t.sender.track?.contentHint === 'detail').mid
  const layers = {}
  let available = 0
  const stats = await pc.getStats()
  for (const r of stats.values()) {
    if (r.type === 'outbound-rtp' && r.mid === mid && r.rid) layers[r.rid] = { bytes: r.bytesSent || 0, frames: r.framesEncoded || 0, width: r.frameWidth || 0, fps: r.framesPerSecond || 0, target: r.targetBitrate || 0, limit: r.qualityLimitationReason, codec: stats.get(r.codecId)?.mimeType ?? '' }
    if (r.type === 'candidate-pair' && r.nominated && r.availableOutgoingBitrate) available = r.availableOutgoingBitrate
  }
  return { layers, available, twcc: /transport-cc/.test(pc.remoteDescription?.sdp ?? '') }
})()
`

// The publisher's open uploads, the share's apart from the camera's, and
// whether the server answered each with transport-wide congestion control.
export const uploads = `
window.__pcs
  .filter((pc) => pc.signalingState !== 'closed' && pc.getSenders().some((s) => s.track))
  .map((pc) => ({ share: pc.getSenders().some((s) => s.track?.contentHint === 'detail'), twcc: /transport-cc/.test(pc.remoteDescription?.sdp ?? '') }))
`

export function tileByLabel(suffix) {
  return [...document.querySelectorAll('.group')].find((g) => g.querySelector('.hud-label')?.textContent.trim().endsWith(suffix))
}

export const remoteScreen = `
(() => {
  const tile = (${tileByLabel.toString()})('screen')
  const video = tile?.querySelector('video')
  return video ? { width: video.videoWidth, frames: video.getVideoPlaybackQuality().totalVideoFrames } : null
})()
`

// What the viewer made of the share, read at `at` on the page's clock.
export const shareReceiveCounters = `
(async () => {
  const tile = (${tileByLabel.toString()})('screen')
  const trackId = tile?.querySelector('video')?.srcObject?.getVideoTracks()[0]?.id
  for (const pc of window.__pcs.filter((pc) => pc.signalingState !== 'closed')) {
    for (const r of (await pc.getStats()).values()) {
      if (r.type === 'inbound-rtp' && r.kind === 'video' && r.trackIdentifier === trackId) {
        return { at: performance.now(), decoded: r.framesDecoded || 0, keyframes: r.keyFramesDecoded || 0, freezes: r.freezeCount || 0, frozenMs: Math.round((r.totalFreezesDuration || 0) * 1000), plis: r.pliCount || 0, lost: r.packetsLost || 0, nacks: r.nackCount || 0, width: r.frameWidth || 0 }
      }
    }
  }
  return null
})()
`

// The share's outgoing encodings by rid, read at `at` on the page's
// clock, found by the share's own connection, which carries no other
// video.
export const shareSendCounters = `
(async () => {
  const pc = ${sharePeerConnection}
  if (!pc) return null
  const layers = {}
  for (const r of (await pc.getStats()).values()) {
    if (r.type === 'outbound-rtp' && r.kind === 'video' && r.rid) layers[r.rid] = { ssrc: r.ssrc, encoded: r.framesEncoded || 0, keyframes: r.keyFramesEncoded || 0, plis: r.pliCount || 0, firs: r.firCount || 0, limit: r.qualityLimitationReason, bytes: r.bytesSent || 0, target: r.targetBitrate || 0, nacks: r.nackCount || 0, retransmitted: r.retransmittedBytesSent || 0 }
  }
  return { at: performance.now(), layers }
})()
`
