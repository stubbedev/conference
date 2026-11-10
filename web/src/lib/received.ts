// What a viewer still receives from a source once an offer is answered.
// The SFU takes a track away by renegotiating its media section to
// inactive, and the browsers say so in different ways: the track mutes
// (as it does whenever nothing arrives), leaves the stream the sender
// named (never one built around it here) and does not end. The direction
// the negotiation settled is the one answer every engine gives alike.

/** What a negotiation settled for one media section, as its transceiver reports it. */
export type Negotiated = Pick<RTCRtpTransceiver, 'mid' | 'currentDirection'>

const RECEIVING: readonly RTCRtpTransceiverDirection[] = ['recvonly', 'sendrecv']

/** The tracks, by mid, whose section the answered offer no longer sends on. */
export function unreceived<Track>(tracks: ReadonlyMap<string, Track>, negotiated: readonly Negotiated[]): [string, Track][] {
  const receiving = new Set<string>()
  for (const { mid, currentDirection } of negotiated) {
    if (mid !== null && currentDirection !== null && RECEIVING.includes(currentDirection)) receiving.add(mid)
  }

  return [...tracks].filter(([mid]) => !receiving.has(mid))
}
