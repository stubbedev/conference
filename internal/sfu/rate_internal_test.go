package sfu

import (
	"testing"
)

// second is one REMB period in which the connection delivered bps and
// lost the given share of the packets the publisher sent.
func second(bps, sent, lost uint64) linkSample {
	return linkSample{
		arrived: receiveTotals{bytes: bps / bitsPerByte, expected: sent, received: sent - lost},
		elapsed: rembInterval,
	}
}

const (
	burstRate     = 8_000_000
	burstPackets  = 800
	stillRate     = 40_000
	stillPackets  = 4
	typingRate    = 400_000
	typingPackets = 40
)

func estimateAfter(seconds ...linkSample) uplinkEstimate {
	estimate := uplinkEstimate{limit: unlimited, peak: 0}
	for _, sample := range seconds {
		estimate = estimate.next(sample)
	}

	return estimate
}

func repeat(sample linkSample, times int) []linkSample {
	out := make([]linkSample, times)
	for index := range out {
		out[index] = sample
	}

	return out
}

// TestUplinkEstimateStaysUnlimitedOnACleanLink is the reason the share has
// a connection of its own: a still screen sends almost nothing, and an
// estimate that followed the send rate down would hold the next scroll to
// a trickle. Nothing measured limits a clean link, so nothing is limited.
func TestUplinkEstimateStaysUnlimitedOnACleanLink(t *testing.T) {
	t.Parallel()

	timeline := append(repeat(second(burstRate, burstPackets, 0), 3), repeat(second(stillRate, stillPackets, 0), 120)...)

	estimate := estimateAfter(timeline...)
	if estimate.limit.bound {
		t.Fatalf("limit %d after a burst and two still minutes on a clean link, want none", estimate.limit.bps)
	}

	bitrate, send := rembFor(feedbackReceiverEstimate, estimate.limit, false)
	if !send || bitrate != browserMaxBitrate {
		t.Fatalf("REMB %d (sent %v) for the unlimited share, want the browser's maximum %d", bitrate, send, browserMaxBitrate)
	}
}

// TestUplinkEstimateHoldsWhileTheScreenIsStill: once loss has limited the
// connection, a still screen afterwards says nothing new about the link
// and must not walk the limit down towards what idling sends.
func TestUplinkEstimateHoldsWhileTheScreenIsStill(t *testing.T) {
	t.Parallel()

	limited := estimateAfter(second(burstRate, burstPackets, burstPackets/4))

	lossy := second(burstRate, burstPackets, burstPackets/4)

	still := estimateAfter(append([]linkSample{lossy}, repeat(second(stillRate, stillPackets, 1), 120)...)...)
	if still.limit != limited.limit {
		t.Fatalf("limit %+v after two lossy-looking still minutes, want it held at %+v", still.limit, limited.limit)
	}

	typing := estimateAfter(append([]linkSample{lossy}, repeat(second(typingRate, typingPackets, 0), 120)...)...)
	if typing.limit.bps < limited.limit.bps {
		t.Fatalf("limit %d after two clean minutes of light typing, want at least the %d it had", typing.limit.bps, limited.limit.bps)
	}
}

func TestUplinkEstimateBacksOffUnderHeavyLoss(t *testing.T) {
	t.Parallel()

	once := estimateAfter(second(burstRate, burstPackets, burstPackets/4))

	want := backOff(burstRate, 64)
	if !once.limit.bound || once.limit.bps != want {
		t.Fatalf("limit %+v after 25%% loss at %d bps, want %d", once.limit, burstRate, want)
	}

	again := estimateAfter(second(burstRate, burstPackets, burstPackets/4), second(burstRate, burstPackets, burstPackets/4))
	if again.limit.bps >= once.limit.bps {
		t.Fatalf("limit %d after a second lossy period, want it below %d", again.limit.bps, once.limit.bps)
	}

	floor := estimateAfter(repeat(second(burstRate, burstPackets, burstPackets), 40)...)
	if floor.limit.bps != minPublisherBitrate {
		t.Fatalf("limit %d after total loss, want the floor %d", floor.limit.bps, minPublisherBitrate)
	}
}

func TestUplinkEstimateHoldsUnderModerateLoss(t *testing.T) {
	t.Parallel()

	limited := estimateAfter(second(burstRate, burstPackets, burstPackets/4))

	held := limited.next(second(burstRate, burstPackets, burstPackets/20))
	if held.limit != limited.limit {
		t.Fatalf("limit %+v after 5%% loss, want it held at %+v", held.limit, limited.limit)
	}

	unlimitedLink := estimateAfter(repeat(second(burstRate, burstPackets, burstPackets/20), 10)...)
	if unlimitedLink.limit.bound {
		t.Fatalf("limit %d from moderate loss alone, want none", unlimitedLink.limit.bps)
	}
}

// TestUplinkEstimateRecoversOnACleanLink: after a congested moment the
// limit grows back while the link is clean and the publisher uses it, but
// never past half again the most the connection has delivered cleanly.
func TestUplinkEstimateRecoversOnACleanLink(t *testing.T) {
	t.Parallel()

	estimate := estimateAfter(second(burstRate, burstPackets, 0), second(burstRate, burstPackets, burstPackets/2))
	dropped := estimate.limit.bps

	estimate = estimate.next(second(dropped, burstPackets, 0))
	if estimate.limit.bps <= dropped {
		t.Fatalf("limit %d after a clean period at the limit, want it above %d", estimate.limit.bps, dropped)
	}

	for range 60 {
		estimate = estimate.next(second(estimate.limit.bps, burstPackets, 0))
	}

	ceiling := estimate.peak * throughputHeadroomNum / throughputHeadroomDen
	if estimate.limit.bps > ceiling {
		t.Fatalf("limit %d after a clean minute, want at most %d, half again the %d delivered cleanly",
			estimate.limit.bps, ceiling, estimate.peak)
	}

	if estimate.limit.bps <= burstRate {
		t.Fatalf("limit %d after a clean minute at the limit, want it above the %d delivered before the loss", estimate.limit.bps, burstRate)
	}
}

func TestViewerLimitWinsWhenLower(t *testing.T) {
	t.Parallel()

	uplink := estimateAfter(second(burstRate, burstPackets, burstPackets/4)).limit
	viewer := capAt(600_000)

	for _, feedback := range []congestionFeedback{feedbackReceiverEstimate, feedbackTransportWide} {
		bitrate, send := rembFor(feedback, viewer.tighter(uplink), false)
		if !send || bitrate != viewer.bps {
			t.Fatalf("REMB %d (sent %v) with a viewer limited to %d, want the viewer's limit", bitrate, send, viewer.bps)
		}
	}

	bitrate, _ := rembFor(feedbackReceiverEstimate, capAt(burstRate*2).tighter(uplink), false)
	if bitrate != uplink.bps {
		t.Fatalf("REMB %d with a viewer above the uplink limit, want the uplink's %d", bitrate, uplink.bps)
	}

	floored, _ := rembFor(feedbackReceiverEstimate, capAt(minViewerBitrate), false)
	if floored != minPublisherBitrate {
		t.Fatalf("REMB %d for a viewer at the floor, want the publisher floor %d", floored, minPublisherBitrate)
	}
}

// TestTransportWideUplinkGetsNoREMBUnlessLimited: the browser's own
// delay-based estimate measures that uplink, so the server only speaks to
// pass on a limit, and once more to lift it.
func TestTransportWideUplinkGetsNoREMBUnlessLimited(t *testing.T) {
	t.Parallel()

	if bitrate, send := rembFor(feedbackTransportWide, unlimited, false); send {
		t.Fatalf("REMB %d on an unlimited transport-wide uplink, want none", bitrate)
	}

	if bitrate, send := rembFor(feedbackTransportWide, unlimited, true); !send || bitrate != browserMaxBitrate {
		t.Fatalf("REMB %d (sent %v) lifting an earlier limit, want the browser's maximum %d", bitrate, send, browserMaxBitrate)
	}
}

func TestSequenceCountFollowsLossReorderingAndWrap(t *testing.T) {
	t.Parallel()

	var count sequenceCount
	for _, seq := range []uint16{65533, 65534, 1, 0, 3} {
		count = count.observe(seq)
	}

	if got := count.expected(); got != 7 {
		t.Fatalf("expected %d packets from 65533 to 3 across the wrap, want 7", got)
	}

	if count.received != 5 {
		t.Fatalf("received %d, want 5 (65535 and 2 lost, 0 late)", count.received)
	}

	arrived := receiveTotals{bytes: 0, expected: count.expected(), received: count.received}

	fraction, known := linkSample{arrived: arrived, elapsed: rembInterval}.fractionLost()
	if known {
		t.Fatalf("loss %d/256 from %d packets, want it unknown below %d", fraction, count.expected(), minLossPackets)
	}
}
