// Encoder configuration for everything a member publishes. A camera goes
// out as three encodings so the SFU can give each viewer the layer its
// layout and network can use; a screen share goes out as one full-quality
// stream, because text has to stay legible.

/** How many frames a second a shared screen is encoded at. */
export const SCREEN_SHARE_FPS = 30

/** The default publish ceiling of a server, in bits per second. */
export const PUBLISH_CEILING_BPS = 2_500_000

/** One share may use the whole ceiling: it is the only video it sends. */
export const SCREEN_SHARE_MAX_BITRATE = PUBLISH_CEILING_BPS

/**
 * The camera's layers, from thumbnail to full size. Their caps add up to
 * the default publish ceiling, so a camera alone in a call neither leaves
 * the high layer starved nor promises the encoder more than the uplink
 * may send.
 */
export const CAMERA_LAYERS: readonly RTCRtpEncodingParameters[] = [
  { rid: 'l', scaleResolutionDownBy: 4, maxBitrate: 150_000 },
  { rid: 'm', scaleResolutionDownBy: 2, maxBitrate: 600_000 },
  { rid: 'h', scaleResolutionDownBy: 1, maxBitrate: 1_750_000 },
]

/** The share's uplink is worth more than the camera's while it lasts. */
const CAMERA_SHARING_MAX_BITRATE = 300_000

/**
 * The camera while a screen is shared. It is a thumbnail on everyone's
 * screen then, and everything the uplink has left belongs to the share.
 */
export const CAMERA_SHARING_LAYERS: readonly RTCRtpEncodingParameters[] = CAMERA_LAYERS.map((layer) => ({
  ...layer,
  maxBitrate: Math.min(layer.maxBitrate ?? CAMERA_SHARING_MAX_BITRATE, CAMERA_SHARING_MAX_BITRATE),
}))

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

/**
 * relayerParameters applies the bitrate caps of layers to a sender's own
 * encodings, matching them by rid and falling back to their position. A
 * sender's encodings cannot be added or removed, only retuned, so this is
 * how a camera becomes a thumbnail while a screen is shared and comes
 * back afterwards.
 */
export function relayerParameters(
  parameters: RTCRtpSendParameters,
  layers: readonly RTCRtpEncodingParameters[],
): RTCRtpSendParameters {
  return {
    ...parameters,
    encodings: parameters.encodings.map((encoding, index) => {
      const layer = layers.find((candidate) => candidate.rid === encoding.rid) ?? layers[index]

      return layer?.maxBitrate ? { ...encoding, maxBitrate: layer.maxBitrate } : encoding
    }),
  }
}
