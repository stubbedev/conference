package sfu

import (
	"fmt"

	"github.com/pion/webrtc/v4"
)

// Upstream names one of the peer connections a member publishes on. A
// shared screen gets a connection of its own: its bandwidth estimate is
// kept apart from the camera's, so it stays high while the screen is
// still and the next change is not encoded down to what idling sent.
type Upstream int

const (
	// UpstreamMedia carries the camera, the microphone and translated voices.
	UpstreamMedia Upstream = iota
	// UpstreamScreen carries a shared screen and its sound.
	UpstreamScreen

	upstreamCount
)

// PCID is the signaling name of the connection.
func (u Upstream) PCID() string {
	if u == UpstreamScreen {
		return "up-screen"
	}

	return "up"
}

func (u Upstream) String() string { return u.PCID() }

// parseUpstream reads the signaling name of an upstream connection.
func parseUpstream(pcID string) (Upstream, error) {
	for up := range upstreamCount {
		if up.PCID() == pcID {
			return up, nil
		}
	}

	return 0, fmt.Errorf("%w: unknown upstream connection %q", ErrBadRequest, pcID)
}

// feedback is the congestion feedback the server gives a publisher on
// this connection. The camera's connection gets transport-wide feedback,
// so the browser's delay-based estimate tracks the uplink closely. The
// share's connection leaves it out: the browser's loss-based estimate
// then sits at the server's REMB ceiling instead of settling near what a
// still screen sends.
func (u Upstream) feedback() congestionFeedback {
	if u == UpstreamScreen {
		return feedbackReceiverEstimate
	}

	return feedbackTransportWide
}

// carries reports whether a track of kind belongs on this connection.
func (u Upstream) carries(kind Kind) bool {
	return (u == UpstreamScreen) == (kind == KindScreen || kind == KindScreenAudio)
}

// defaultKind labels a track the publisher's offer did not name.
func (u Upstream) defaultKind(codecType webrtc.RTPCodecType) Kind {
	audio := codecType == webrtc.RTPCodecTypeAudio

	switch {
	case u == UpstreamScreen && audio:
		return KindScreenAudio
	case u == UpstreamScreen:
		return KindScreen
	case audio:
		return KindAudio
	default:
		return KindCamera
	}
}

// trackKey names one upstream track of a member: mids are only unique
// within one peer connection, and a member publishes on several.
type trackKey struct {
	up  Upstream
	mid string
}

func (k trackKey) String() string { return k.up.PCID() + "/" + k.mid }
