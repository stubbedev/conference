package sfu

import (
	"sync"
	"time"
)

// viewerRate tracks a sustainable downlink bitrate for one viewer,
// following Galène's loss-based controller: multiplicative decrease on
// loss, increase while loss is low, clamped by whatever REMB the viewer
// itself reports. Before any heavy loss nothing limits the viewer but
// its REMB. The increase only happens while the viewer is sent close to
// the estimate, since a stream sending less is not probing the link, so
// the estimate never runs far above what was actually delivered. It
// recovers in both directions: the walk back up is paced by elapsed
// time, and a viewer's own REMB is taken as evidence of recovered
// headroom, so a single-layer stream that dropped during a blip returns
// to full quality in seconds instead of creeping back.
type viewerRate struct {
	mu    sync.Mutex
	loss  bitrateLimit // estimate from receiver reports, none before heavy loss
	remb  bitrateLimit // the viewer's own REMB, none before one arrives
	clean bool         // the last receiver report showed no loss
}

func newViewerRate() viewerRate {
	return viewerRate{mu: sync.Mutex{}, loss: unlimited, remb: unlimited, clean: false}
}

// Galène grows the estimate only while what is sent reaches seven
// eighths of it: below that the stream is not probing the bottleneck.
const (
	probingNum = 7
	probingDen = 8
)

// lift takes the viewer's own REMB as evidence of recovered headroom: the
// viewer measuring its own downlink sees a network recover long before a
// 5%-a-second walk notices. Callers hold vr.mu.
func (vr *viewerRate) lift(rate uint64) uint64 {
	if !vr.remb.bound {
		return rate
	}

	return max(rate, vr.remb.bps)
}

// updateLoss applies one receiver report: the fraction of packets the
// viewer lost since its previous report, elapsed ago, while it was sent
// delivered bits per second.
func (vr *viewerRate) updateLoss(fractionLost uint8, elapsed time.Duration, delivered uint64) {
	vr.mu.Lock()
	defer vr.mu.Unlock()

	if elapsed <= 0 {
		elapsed = rateGainPeriod
	}

	switch {
	case fractionLost > highLossFraction:
		vr.clean = false

		// Nothing measured yet: the track has not been sent for a full
		// period, so there is no rate to back off from.
		if delivered == 0 {
			return
		}

		vr.loss = capAt(max(backOff(vr.loss.clamp(delivered), fractionLost), minViewerBitrate))
	case fractionLost < lowLossFraction:
		vr.clean = true

		if !vr.loss.bound {
			return
		}

		rate := vr.loss.bps
		if delivered*probingDen >= rate*probingNum {
			rate = viewerGain.grow(rate, elapsed)
		}

		vr.loss = capAt(vr.lift(rate))
	}
}

func (vr *viewerRate) setREMB(bitrate float64) {
	if bitrate <= 0 {
		return
	}

	vr.mu.Lock()
	defer vr.mu.Unlock()

	vr.remb = capAt(uint64(bitrate))

	// A viewer that is not losing packets and now says it has more room
	// is right about its own link; follow it instead of waiting for the
	// ramp to rediscover the bandwidth.
	if vr.clean && vr.loss.bound {
		vr.loss = capAt(vr.lift(vr.loss.bps))
	}
}

// limit is the most the viewer can take: the tighter of its loss
// estimate and its own REMB.
func (vr *viewerRate) limit() bitrateLimit {
	vr.mu.Lock()
	defer vr.mu.Unlock()

	return vr.loss.tighter(vr.remb)
}
