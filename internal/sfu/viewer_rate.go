package sfu

import (
	"sync"
	"time"

	"github.com/pion/rtcp"
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
//
// The decrease is the publisher estimate's (see backedOff): a shared
// screen is still most of the time, and a viewer that loses packets of a
// still screen has got little because little was sent. Reports are
// gathered until they cover enough packets to tell a loss rate, as
// libwebrtc gathers them: a viewer reports when it likes, and the few
// packets of a still screen between two reports tell nothing alone.
type viewerRate struct {
	mu    sync.Mutex
	loss  bitrateLimit // estimate from receiver reports, none before heavy loss
	remb  bitrateLimit // the viewer's own REMB, none before one arrives
	clean bool         // the last reports that told showed next to no loss
	peak  uint64       // the highest rate the viewer has been delivered

	// The viewer's latest report, and what the reports since the last
	// ones that told cover: their packets and the time they span.
	reported reportedCount
	pending  receiveTotals
	waited   time.Duration
}

func newViewerRate() viewerRate {
	return viewerRate{
		mu: sync.Mutex{}, loss: unlimited, remb: unlimited, clean: false, peak: 0,
		reported: nothingReported, pending: noPackets, waited: 0,
	}
}

// reportedCount is the count one receiver report keeps of a track since
// the viewer began receiving it: the highest sequence number it got, and
// how many of the packets up to there it never did. The packets of a
// period come from the difference of two reports, as RFC 3550 has a
// sender work them out: that holds when a report between the two was
// lost, which the fraction a report states of itself does not.
type reportedCount struct {
	highest uint32 // extended highest sequence number received
	lost    uint32 // cumulative number of packets lost, 24 bits, signed
	known   bool
}

// nothingReported is where a viewer starts, before its first report.
//
//nolint:gochecknoglobals // an immutable value, the zero count spelled out
var nothingReported = reportedCount{highest: 0, lost: 0, known: false}

// noPackets is a period no report has added to yet.
//
//nolint:gochecknoglobals // an immutable value, the zero period spelled out
var noPackets = receiveTotals{bytes: 0, expected: 0, received: 0}

func reportedBy(report rtcp.ReceptionReport) reportedCount {
	return reportedCount{highest: report.LastSequenceNumber, lost: report.TotalLost, known: true}
}

// A receiver report carries its cumulative loss in 24 bits of a 32-bit
// word.
const (
	wordBits = 32
	lostBits = 24
)

// since is what the viewer expected and received between earlier and
// this report. It reports false when the count does not continue the
// earlier one: there is none, or the viewer's receiver started over. A
// packet counted lost that arrives after all lowers the cumulative loss
// again, so a period can receive more than it expected.
func (c reportedCount) since(earlier reportedCount) (receiveTotals, bool) {
	//nolint:gosec // the wrap to int32 is the serial-number comparison of RFC 3550
	expected := int32(c.highest - earlier.highest)
	if !c.known || !earlier.known || expected < 0 {
		return noPackets, false
	}

	//nolint:gosec // the shifts sign-extend the 24-bit difference
	lost := int32((c.lost-earlier.lost)<<(wordBits-lostBits)) >> (wordBits - lostBits)

	return receiveTotals{
		bytes:    0,
		expected: uint64(expected),
		received: uint64(max(int64(expected)-int64(lost), 0)),
	}, true
}

// deliveredTo is what one REMB period delivers to a viewer that got the
// given share of its packets, of a track that arrives at delivered bits
// per second. The server measures a track's rate once a REMB period and
// a viewer reports when it likes, so the rate is the track's latest and
// the share is what the viewer's reports say got through.
func deliveredTo(packets receiveTotals, delivered uint64) linkSample {
	sent := delivered * uint64(rembInterval) / (bitsPerByte * uint64(time.Second))

	through := uint64(0)
	if packets.expected > 0 {
		through = sent * min(packets.received, packets.expected) / packets.expected
	}

	return linkSample{
		arrived: receiveTotals{bytes: through, expected: packets.expected, received: packets.received},
		elapsed: rembInterval,
	}
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

// updateLoss applies one receiver report, which came elapsed after the
// viewer's previous one, while the track arrives at delivered bits per
// second. The viewer's first report, and the first of a receiver that
// started over, only say where its count begins.
func (vr *viewerRate) updateLoss(report reportedCount, elapsed time.Duration, delivered uint64) {
	vr.mu.Lock()
	defer vr.mu.Unlock()

	packets, continues := report.since(vr.reported)
	vr.reported = report

	if !continues {
		vr.pending, vr.waited = noPackets, 0

		return
	}

	vr.pending, vr.waited = vr.pending.plus(packets), vr.waited+elapsed
	sample := deliveredTo(vr.pending, delivered)

	fraction, known := sample.fractionLost()
	if !known {
		return
	}

	waited := vr.waited
	vr.pending, vr.waited = noPackets, 0

	vr.judge(sample, fraction, waited)
}

// judge applies a period whose loss tells: sample is what it delivered,
// fraction its loss, and waited the time since the previous one. Callers
// hold vr.mu.
func (vr *viewerRate) judge(sample linkSample, fraction uint8, waited time.Duration) {
	rate := sample.bitrate()
	vr.peak = max(vr.peak, rate)
	vr.clean = fraction < lowLossFraction

	switch {
	case fraction > highLossFraction:
		// Nothing measured yet: the track has not arrived for a full
		// period, so there is no rate to back off from.
		if vr.peak == 0 {
			return
		}

		vr.loss = sample.backedOff(vr.loss, vr.peak, fraction, minViewerBitrate)
	case vr.clean && vr.loss.bound:
		grown := vr.loss.bps
		if rate*probingDen >= grown*probingNum {
			grown = viewerGain.grow(grown, waited)
		}

		vr.loss = capAt(vr.lift(grown))
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
