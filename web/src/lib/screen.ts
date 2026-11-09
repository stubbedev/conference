import { SCREEN_SHARE_FPS } from './encodings.ts'

// A screen share's picture, sound and picker. The encoder settings that
// carry it live in encodings.ts, next to the camera's.

export const SCREEN_AUDIO_KIND = 'screen-audio'

export const SCREEN_CAPTURE: MediaTrackConstraints = { frameRate: { ideal: SCREEN_SHARE_FPS } }

/**
 * requestDisplay asks for a screen, with its sound when the browser offers
 * it: sharing a tab that plays something is silent otherwise. A browser
 * that has no audio in the picker still shares the picture.
 */
export async function requestDisplay(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video: SCREEN_CAPTURE, audio: true })
  } catch (err) {
    if (!(err instanceof TypeError)) throw err

    return navigator.mediaDevices.getDisplayMedia({ video: SCREEN_CAPTURE })
  }
}

/**
 * screenTracks is the track list of one screen share: the picture and the
 * sound of a shared tab arrive as separate tracks, and the tile renders
 * them from one stream, the way it renders a camera and its microphone.
 */
export function screenTracks(
  existing: readonly MediaStreamTrack[],
  incoming: readonly MediaStreamTrack[],
): MediaStreamTrack[] {
  const live = existing.filter((track) => track.readyState !== 'ended')
  const known = new Set(live.map((track) => track.id))
  const added = incoming.filter((track) => track.readyState !== 'ended' && !known.has(track.id))

  return [...live, ...added]
}
