package sfu

import (
	"math"
	"sync/atomic"
	"time"
)

// bitrateLimit is how fast a stream may go, in bits per second: a cap
// some measurement put in place, or none.
type bitrateLimit struct {
	bps   uint64
	bound bool
}

// unlimited is the limit no measurement has set.
//
//nolint:gochecknoglobals // an immutable value, the zero limit spelled out
var unlimited = bitrateLimit{bps: 0, bound: false}

func capAt(bps uint64) bitrateLimit {
	return bitrateLimit{bps: bps, bound: true}
}

// tighter is whichever of the two limits allows less.
func (l bitrateLimit) tighter(other bitrateLimit) bitrateLimit {
	switch {
	case !l.bound:
		return other
	case !other.bound:
		return l
	default:
		return capAt(min(l.bps, other.bps))
	}
}

// Loss-controller tuning shared by the viewer and the publisher
// estimates, as in Galène and in libwebrtc's send-side estimate:
// receiver-report fraction-lost thresholds (in 1/256 units, about 2% and
// 10%) and the multiplicative decrease between them.
const (
	lowLossFraction  = 5
	highLossFraction = 25
	lossScale        = 512
	fractionScale    = 256

	// rateGainPeriod is how long one multiplicative-increase step takes.
	// The increase is scaled by the time since the previous report, so
	// the ramp keeps its pace whether reports come every 200 ms or every
	// two seconds.
	rateGainPeriod = time.Second

	// maxGainSteps bounds one increase, so an estimate that has been
	// quiet for minutes does not jump from the floor to the top at once.
	maxGainSteps = 16
)

// rateGain is one multiplicative-increase step, num/den per period.
type rateGain struct{ num, den uint64 }

// Galène grows a viewer's estimate by 5% a second; libwebrtc grows the
// sender's own loss-based estimate by 8%, so the publisher's estimate
// keeps pace with the browser's and never holds it back on a clean link.
const (
	galeneGainNum = 269
	galeneGainDen = 256
	gccGainNum    = 108
	gccGainDen    = 100
)

//nolint:gochecknoglobals // immutable tuning, the two controllers' published constants
var (
	viewerGain = rateGain{num: galeneGainNum, den: galeneGainDen}
	senderGain = rateGain{num: gccGainNum, den: gccGainDen}
)

// grow applies one increase for the time elapsed since the previous
// report.
func (g rateGain) grow(rate uint64, elapsed time.Duration) uint64 {
	steps := min(max(1, int(elapsed/rateGainPeriod)), maxGainSteps)

	for range steps {
		rate = rate * g.num / g.den
	}

	return rate
}

// backOff is the loss controller's multiplicative decrease: a link that
// lost fractionLost/256 of its packets gets half that fraction less.
func backOff(rate uint64, fractionLost uint8) uint64 {
	return rate * (lossScale - uint64(fractionLost)) / lossScale
}

// receiveTotals counts what arrived on one encoding since it appeared.
// Expected and received count the publisher's original packets by
// sequence number, retransmissions aside, the way a receiver report
// counts them; bytes counts everything, retransmissions included.
type receiveTotals struct {
	bytes    uint64
	expected uint64
	received uint64
}

func (t receiveTotals) since(earlier receiveTotals) receiveTotals {
	return receiveTotals{
		bytes:    t.bytes - earlier.bytes,
		expected: t.expected - earlier.expected,
		received: t.received - earlier.received,
	}
}

func (t receiveTotals) plus(other receiveTotals) receiveTotals {
	return receiveTotals{
		bytes:    t.bytes + other.bytes,
		expected: t.expected + other.expected,
		received: t.received + other.received,
	}
}

// sequenceCount follows one stream's sequence numbers to count the
// packets the publisher sent and the ones that arrived.
type sequenceCount struct {
	started  bool
	first    uint64 // extended sequence number of the first packet
	highest  uint64 // highest extended sequence number seen
	received uint64
}

// observe counts one original packet. A packet older than the highest
// seen is a late or reordered one: it arrived, but was already expected.
func (c sequenceCount) observe(seq uint16) sequenceCount {
	if !c.started {
		return sequenceCount{started: true, first: uint64(seq), highest: uint64(seq), received: 1}
	}

	c.received++

	//nolint:gosec // the wrap to int16 is the serial-number comparison of RFC 3550
	if ahead := int16(seq - uint16(c.highest)); ahead > 0 {
		c.highest += uint64(ahead)
	}

	return c
}

func (c sequenceCount) expected() uint64 {
	if !c.started {
		return 0
	}

	return c.highest - c.first + 1
}

// arrivals publishes an encoding's receiveTotals from its forwarding
// loop to the REMB ticker.
type arrivals struct {
	bytes    atomic.Uint64
	expected atomic.Uint64
	received atomic.Uint64
}

func (a *arrivals) record(size int, count sequenceCount) {
	a.bytes.Add(uint64(max(size, 0)))
	a.expected.Store(count.expected())
	a.received.Store(count.received)
}

func (a *arrivals) load() receiveTotals {
	return receiveTotals{bytes: a.bytes.Load(), expected: a.expected.Load(), received: a.received.Load()}
}

// linkSample is what one connection delivered over one period.
type linkSample struct {
	arrived receiveTotals
	elapsed time.Duration
}

const bitsPerByte = 8

// bitrate is the rate the connection delivered, in bits per second.
func (s linkSample) bitrate() uint64 {
	if s.elapsed <= 0 {
		return 0
	}

	return s.arrived.bytes * bitsPerByte * uint64(time.Second) / uint64(s.elapsed)
}

// minLossPackets is the fewest packets a period must have been expected
// to carry for its loss to mean anything; libwebrtc ignores receiver
// reports covering fewer. A still screen sends a handful of packets a
// second, so its periods tell nothing about loss and change nothing.
const minLossPackets = 20

// fractionLost is the period's loss in 1/256 units, as a receiver
// report states it, and whether enough packets were expected to tell.
func (s linkSample) fractionLost() (uint8, bool) {
	expected := s.arrived.expected
	if expected < minLossPackets {
		return 0, false
	}

	lost := expected - min(s.arrived.received, expected)

	return uint8(min(lost*fractionScale/expected, math.MaxUint8)), true
}

// throughputHeadroom bounds the publisher's estimate once loss has
// limited it: at most half again what the connection has delivered
// cleanly, the bound libwebrtc's delay-based controller puts on its own
// estimate (1.5 times the measured throughput).
const (
	throughputHeadroomNum = 3
	throughputHeadroomDen = 2
)

// uplinkEstimate is the server's loss-based estimate of one publisher
// connection that carries no transport-wide feedback, the only estimate
// the browser gets there besides its own reading of the receiver
// reports. It follows GCC's loss controller: heavy loss backs it off to
// what actually got through, moderate loss holds it, a clean link grows
// it. It does not follow the send rate: a still screen sends almost
// nothing, and an estimate that settled there would hold the next burst
// to a trickle.
type uplinkEstimate struct {
	// limit is none until the connection loses packets heavily: before
	// that nothing measured says the uplink cannot carry more.
	limit bitrateLimit

	// peak is the highest rate the connection delivered without loss.
	peak uint64
}

func (e uplinkEstimate) next(sample linkSample) uplinkEstimate {
	fraction, known := sample.fractionLost()
	if !known {
		return e
	}

	rate := sample.bitrate()

	switch {
	case fraction > highLossFraction:
		through := rate
		if e.limit.bound {
			through = min(through, e.limit.bps)
		}

		e.limit = capAt(max(backOff(through, fraction), minPublisherBitrate))
	case fraction < lowLossFraction:
		e.peak = max(e.peak, rate)

		if e.limit.bound {
			ceiling := e.peak * throughputHeadroomNum / throughputHeadroomDen
			e.limit = capAt(max(e.limit.bps, min(senderGain.grow(e.limit.bps, sample.elapsed), ceiling)))
		}
	}

	return e
}

// browserMaxBitrate is where libwebrtc caps a send-side estimate that
// nothing in the SDP limits (kDefaultMaxBitrate, 1 Gbps): a REMB this
// high limits nothing, yet is a finite estimate the browser starts from.
const browserMaxBitrate = 1_000_000_000

// rembFor is the REMB a publisher connection gets this period, if any.
//
// On a connection without transport-wide feedback the server's REMB is
// the browser's only receiver estimate. libwebrtc caps its target at the
// REMB and, for the first two seconds, starts its estimate from it; with
// no REMB at all it starts at 300 kbps and climbs 8% a second, so a
// share would take most of a minute to reach the rate a scroll needs.
// That connection therefore always gets one, at the browser's maximum
// when nothing limits it.
//
// With transport-wide feedback the browser's delay-based estimate
// measures the uplink itself, and a REMB is only sent to carry a limit,
// or once at the browser's maximum to lift the last one.
func rembFor(feedback congestionFeedback, limit bitrateLimit, capped bool) (uint64, bool) {
	switch {
	case limit.bound:
		return max(limit.bps, minPublisherBitrate), true
	case feedback == feedbackReceiverEstimate || capped:
		return browserMaxBitrate, true
	default:
		return 0, false
	}
}
