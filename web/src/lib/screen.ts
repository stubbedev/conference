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
