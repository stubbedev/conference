// Encoder configuration for everything a member publishes. A camera goes
// out as three encodings so the SFU can give each viewer the layer its
// layout and network can use. A screen share goes out as two encodings at
// full resolution, because text has to stay legible: a fluid one, and a
// slow one for viewers whose network cannot hold the fluid one, so they
// never hold it back for everyone else.

/** How many frames a second a shared screen is encoded at. */
export const SCREEN_SHARE_FPS = 30

export const SCREEN_SHARE_LOW_FPS = 5
export const SCREEN_SHARE_LOW_MAX_BITRATE = 500_000

export const SCREEN_CONTENT_HINT = 'detail'
export const DEFAULT_PRIORITY: RTCPriorityType = 'low'
export const SCREEN_SHARE_PRIORITY: RTCPriorityType = 'high'
export const CAMERA_PRIORITY = DEFAULT_PRIORITY
export const CAMERA_SHARING_PRIORITY: RTCPriorityType = 'very-low'

/** The default publish ceiling of a server, in bits per second. */
export const PUBLISH_CEILING_BPS = 4_000_000

/** Both encodings of a share together may use the whole ceiling. */
export const SCREEN_SHARE_MAX_BITRATE = PUBLISH_CEILING_BPS - SCREEN_SHARE_LOW_MAX_BITRATE

export const LAYER_RIDS = ['l', 'm', 'h'] as const

const CAMERA_LAYER_SCALES = [
  { rid: LAYER_RIDS[0], scaleResolutionDownBy: 4 },
  { rid: LAYER_RIDS[1], scaleResolutionDownBy: 2 },
  { rid: LAYER_RIDS[2], scaleResolutionDownBy: 1 },
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

export function withSenderPriority(parameters: RTCRtpSendParameters, priority: RTCPriorityType): RTCRtpSendParameters {
  return {
    ...parameters,
    encodings: parameters.encodings.map((encoding, index) => {
      const own = index === 0 ? priority : DEFAULT_PRIORITY
      return { ...encoding, priority: own, networkPriority: own }
    }),
  }
}

export function cameraSenderParameters(
  parameters: RTCRtpSendParameters,
  layers: readonly RTCRtpEncodingParameters[],
  sharing: boolean,
): RTCRtpSendParameters {
  return sharing
    ? withSenderPriority(relayerParameters(parameters, sharingLayers(layers)), CAMERA_SHARING_PRIORITY)
    : withSenderPriority(relayerParameters(parameters, layers), CAMERA_PRIORITY)
}

export function screenLayers(): RTCRtpEncodingParameters[] {
  return [
    {
      rid: LAYER_RIDS[0],
      scaleResolutionDownBy: 1,
      maxBitrate: SCREEN_SHARE_LOW_MAX_BITRATE,
      maxFramerate: SCREEN_SHARE_LOW_FPS,
    },
    {
      rid: LAYER_RIDS[2],
      scaleResolutionDownBy: 1,
      maxBitrate: SCREEN_SHARE_MAX_BITRATE,
      maxFramerate: SCREEN_SHARE_FPS,
    },
  ]
}

export function screenSenderParameters(parameters: RTCRtpSendParameters): RTCRtpSendParameters {
  return withSenderPriority({ ...parameters, degradationPreference: 'maintain-resolution' }, SCREEN_SHARE_PRIORITY)
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

export function demandParameters(parameters: RTCRtpSendParameters, active: readonly boolean[]): RTCRtpSendParameters {
  return {
    ...parameters,
    encodings: parameters.encodings.map((encoding) => {
      const index = LAYER_RIDS.findIndex((rid) => rid === encoding.rid)
      const wanted = active[index]
      return index < 0 || wanted === undefined ? encoding : { ...encoding, active: wanted }
    }),
  }
}
