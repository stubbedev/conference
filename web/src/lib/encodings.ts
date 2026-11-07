// Encoder configuration for everything a member publishes. A camera goes
// out as three encodings so the SFU can give each viewer the layer its
// layout and network can use; a screen share goes out as one full-quality
// stream, because text has to stay legible.

/** How many frames a second a shared screen is encoded at. */
export const SCREEN_SHARE_FPS = 30

/** The default publish ceiling of a server, in bits per second. */
export const PUBLISH_CEILING_BPS = 4_000_000

/** One share may use the whole ceiling: it is the only video it sends. */
export const SCREEN_SHARE_MAX_BITRATE = PUBLISH_CEILING_BPS

const CAMERA_LAYER_SCALES = [
  { rid: 'l', scaleResolutionDownBy: 4 },
  { rid: 'm', scaleResolutionDownBy: 2 },
  { rid: 'h', scaleResolutionDownBy: 1 },
] as const

const LAYER_BITRATES: readonly { shortSide: number; maxBitrate: number }[] = [
  { shortSide: 1080, maxBitrate: 2_500_000 },
  { shortSide: 720, maxBitrate: 1_750_000 },
  { shortSide: 540, maxBitrate: 1_000_000 },
  { shortSide: 360, maxBitrate: 600_000 },
  { shortSide: 270, maxBitrate: 300_000 },
  { shortSide: 180, maxBitrate: 150_000 },
  { shortSide: 0, maxBitrate: 100_000 },
]

const HD_SHORT_SIDE = 720

const LARGEST_BUDGETED_SHORT_SIDE = Math.max(...LAYER_BITRATES.map((tier) => tier.shortSide))

function layerBitrate(shortSide: number): number {
  const tier = LAYER_BITRATES.find((candidate) => shortSide >= candidate.shortSide)
  if (!tier) throw new Error(`no bitrate tier for a ${shortSide}px layer`)
  return tier.maxBitrate
}

export function cameraLayers(capture: Pick<MediaTrackSettings, 'width' | 'height'>): RTCRtpEncodingParameters[] {
  const reported = capture.width && capture.height ? Math.min(capture.width, capture.height) : HD_SHORT_SIDE
  const shortSide = Math.min(reported, LARGEST_BUDGETED_SHORT_SIDE)
  return CAMERA_LAYER_SCALES.map((layer) => ({
    ...layer,
    maxBitrate: layerBitrate(shortSide / layer.scaleResolutionDownBy),
  }))
}

/** The share's uplink is worth more than the camera's while it lasts. */
const CAMERA_SHARING_MAX_BITRATE = 300_000

/**
 * The camera while a screen is shared. It is a thumbnail on everyone's
 * screen then, and everything the uplink has left belongs to the share.
 */
export function sharingLayers(layers: readonly RTCRtpEncodingParameters[]): RTCRtpEncodingParameters[] {
  return layers.map((layer) => ({
    ...layer,
    maxBitrate: Math.min(layer.maxBitrate ?? CAMERA_SHARING_MAX_BITRATE, CAMERA_SHARING_MAX_BITRATE),
  }))
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
