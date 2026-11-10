package sfu

// backedOff is the limit heavy loss leaves a link with, by the rule the
// publisher's and the viewer's estimates share: fraction of the packets
// of the period s were lost while limit was in place, on a link that has
// delivered peak at its best.
//
// The limit backs off to what got through the period, which is what the
// link carried. A period in which the sender used little of its limit is
// the exception: what got through then is little because little was
// sent, and a limit set by it would hold the next burst to a trickle.
// There the back-off starts from peak, held to the limit in place, so
// loss that persists still walks the limit down. floor is the least the
// limit falls to.
func (s linkSample) backedOff(limit bitrateLimit, peak uint64, fraction uint8, floor uint64) bitrateLimit {
	through := s.bitrate()
	if s.applicationLimited(limit) {
		through = peak
	}

	return capAt(max(backOff(limit.clamp(through), fraction), floor))
}
