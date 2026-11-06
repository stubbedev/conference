// How the browser encodes a shared screen. A screen goes out as a single
// encoding — simulcast layers would blur the text — which leaves the
// encoder alone to trade resolution against frame rate under whatever
// bitrate the room gives it. Its default trade is the wrong one for a
// call: it keeps the resolution and drops frames, so a shared window
// turns into a slideshow. These settings ask for the opposite, with a
// frame rate a display capture actually produces.

export const SCREEN_SHARE_FPS = 30

/** Matches the server's default publish cap, so one share can use it all. */
export const SCREEN_SHARE_MAX_BITRATE = 2_500_000

/** The kind the client announces for the audio a shared tab or window carries. */
export const SCREEN_AUDIO_KIND = 'screen-audio'

/**
 * requestDisplay asks for a screen, with its sound when the browser offers
 * it: sharing a tab that plays something is silent otherwise. A browser
 * that has no audio in the picker still shares the picture.
 */
export async function requestDisplay(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
  } catch (err) {
    if (!(err instanceof TypeError)) throw err

    return navigator.mediaDevices.getDisplayMedia({ video: true })
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
  const known = new Set(existing.filter((track) => track.readyState !== 'ended').map((track) => track.id))
  const added = incoming.filter((track) => track.readyState !== 'ended' && !known.has(track.id))

  return [...existing.filter((track) => track.readyState !== 'ended'), ...added]
}

export function screenSenderParameters(parameters: RTCRtpSendParameters): RTCRtpSendParameters {
  return {
    ...parameters,
    degradationPreference: 'maintain-framerate',
    encodings: parameters.encodings.map((encoding) => ({
      ...encoding,
      maxBitrate: SCREEN_SHARE_MAX_BITRATE,
      maxFramerate: SCREEN_SHARE_FPS,
    })),
  }
}
