package sfu

import "testing"

// lossyStart is the first period a connection is measured in, losing a
// quarter of a burst with nothing delivered before to compare it to.
func lossyStart() linkSample {
	return second(burstRate, burstPackets, burstPackets/4)
}

// TestLossInAConnectionsFirstPeriodSetsALimit is the decision for a share
// that loses heavily in its very first period. The limit is set at once,
// to the back-off from what got through, and not held until a second
// period agrees. Nothing limited the publisher, so what got through is
// the link's own answer to what it was sent, the only measurement there
// is; and this period's REMB is the one the browser starts its estimate
// from, where a publisher on a link that cannot carry its share would
// otherwise stay unlimited through its next burst too.
func TestLossInAConnectionsFirstPeriodSetsALimit(t *testing.T) {
	t.Parallel()

	first := lossyStart()
	fraction, _ := first.fractionLost()

	estimate := estimateAfter(first)

	want := capAt(backOff(first.bitrate(), fraction))
	if estimate.limit != want {
		t.Fatalf("limit %+v after a first period that lost %d/256 while %d bps got through, want %+v, the back-off from that",
			estimate.limit, fraction, first.bitrate(), want)
	}
}

// TestALossyStartIsOutgrownInSixActiveSeconds is what that decision costs
// when the loss was one bad moment on a good link. A still screen says
// nothing about the link, so the limit stays through it and meets the
// next burst; from there six clean seconds raise it past what the
// publisher sent in the period it lost in.
func TestALossyStartIsOutgrownInSixActiveSeconds(t *testing.T) {
	t.Parallel()

	const (
		stillSeconds   = 60
		outgrownWithin = 6
	)

	first := lossyStart()
	sent := first.bitrate() * first.arrived.expected / first.arrived.received

	limited := estimateAfter(first)

	still := limited
	for range stillSeconds {
		still = still.next(second(stillRate, stillPackets, 0))
	}

	if still.limit != limited.limit {
		t.Fatalf("limit %+v after a still minute, want it held at %+v", still.limit, limited.limit)
	}

	active := still
	for range outgrownWithin {
		active = active.next(second(typingRate, typingPackets, 0))
	}

	if active.limit.bound && active.limit.bps < sent {
		t.Fatalf("limit %d after %d clean seconds of activity, want it past the %d bps sent in the lossy first period",
			active.limit.bps, outgrownWithin, sent)
	}
}
