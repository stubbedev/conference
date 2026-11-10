package sfu

import (
	"testing"
	"time"
)

const testDelivered = 2_500_000

// lossReport applies one receiver report of the given fraction lost,
// spaced a second apart the way a viewer reports, while the viewer is
// sent delivered bits per second.
func lossReport(speed *viewerRate, fractionLost uint8, delivered uint64) {
	speed.updateLoss(fractionLost, rateGainPeriod, delivered)
}

// probing applies clean reports while the viewer is sent all its estimate
// allows, the way a single-layer stream held back by it is.
func probing(speed *viewerRate, reports int, elapsed time.Duration) {
	for range reports {
		speed.updateLoss(0, elapsed, speed.limit().bps)
	}
}

func TestViewerRateLimitsNothingBeforeLoss(t *testing.T) {
	t.Parallel()

	speed := newViewerRate()
	lossReport(&speed, 0, testDelivered)

	if got := speed.limit(); got.bound {
		t.Fatalf("limit %d before any loss or REMB, want none", got.bps)
	}
}

// TestViewerRateIgnoresLossBeforeAnythingWasDelivered: a report that
// arrives before the track was measured for a full period has no rate to
// back off from, and must not throw the viewer to the floor.
func TestViewerRateIgnoresLossBeforeAnythingWasDelivered(t *testing.T) {
	t.Parallel()

	speed := newViewerRate()
	lossReport(&speed, 255, 0)

	if got := speed.limit(); got.bound {
		t.Fatalf("limit %d from loss before anything was delivered, want none", got.bps)
	}
}

func TestViewerRateDropsOnLoss(t *testing.T) {
	t.Parallel()

	speed := newViewerRate()
	lossReport(&speed, 64, testDelivered)

	if got := speed.limit(); !got.bound || got.bps >= testDelivered {
		t.Fatalf("limit %+v after 25%% loss, want it below the %d delivered", got, testDelivered)
	}

	for range 10 {
		lossReport(&speed, 255, testDelivered)
	}

	if got := speed.limit(); got.bps > 100_000 {
		t.Fatalf("limit %d after sustained total loss, want it near the floor", got.bps)
	}
}

// TestViewerRateRecoversOnItsOwn is the upward half of the controller: a
// viewer that lost packets and then reports a clean link must climb back
// above what it was sent before, or a single-layer stream stays degraded
// by an old blip for the rest of the call.
func TestViewerRateRecoversOnItsOwn(t *testing.T) {
	t.Parallel()

	speed := newViewerRate()
	lossReport(&speed, 64, testDelivered)

	dropped := speed.limit().bps

	probing(&speed, 30, rateGainPeriod)

	if got := speed.limit().bps; got <= testDelivered {
		t.Fatalf("limit %d after half a minute of clean reports, want it back above %d (was %d)", got, testDelivered, dropped)
	}
}

// TestViewerRateGrowsOnlyWhileProbing: a viewer sent far less than its
// estimate is not testing the link, so a clean report says nothing about
// more room and must not walk the estimate away from what was delivered.
func TestViewerRateGrowsOnlyWhileProbing(t *testing.T) {
	t.Parallel()

	speed := newViewerRate()
	lossReport(&speed, 64, testDelivered)

	held := speed.limit().bps

	for range 60 {
		lossReport(&speed, 0, held/4)
	}

	if got := speed.limit().bps; got != held {
		t.Fatalf("limit %d after a minute of clean reports at a quarter of it, want it held at %d", got, held)
	}
}

// TestViewerRateRecoveryIsPacedByTime: the same number of reports at the
// same spacing has to climb by the same amount, so a viewer reporting
// every 200 ms does not recover five times slower than one reporting
// every second.
func TestViewerRateRecoveryIsPacedByTime(t *testing.T) {
	t.Parallel()

	fast := newViewerRate()
	slow := newViewerRate()

	for _, speed := range []*viewerRate{&fast, &slow} {
		lossReport(speed, 64, testDelivered)
	}

	base := fast.limit().bps

	probing(&fast, 10, rateGainPeriod/5)
	probing(&slow, 10, rateGainPeriod)

	got, want := fast.limit().bps, slow.limit().bps
	if got <= base || want <= base {
		t.Fatalf("limits %d and %d after clean reports, want both above %d", got, want, base)
	}

	if got > want*2 || want > got*2 {
		t.Fatalf("limits %d (five reports a second) and %d (one a second) recovered at different paces", got, want)
	}
}

// TestViewerRateFollowsARisingREMB is the fast path back up: once the
// viewer says its downlink is healthy again, the publisher gets that room
// back on that report instead of creeping up at 5% a second.
func TestViewerRateFollowsARisingREMB(t *testing.T) {
	t.Parallel()

	speed := newViewerRate()
	lossReport(&speed, 64, testDelivered)
	speed.setREMB(300_000)

	if got := speed.limit().bps; got > 300_000 {
		t.Fatalf("limit %d after the viewer capped itself, want at most 300000", got)
	}

	lossReport(&speed, 0, 300_000)
	speed.setREMB(testDelivered)

	if got := speed.limit().bps; got != testDelivered {
		t.Fatalf("limit %d after the viewer's REMB recovered, want its REMB %d", got, testDelivered)
	}
}

// TestViewerRateDoesNotTrustARisingREMBWhileLosing: a viewer whose last
// report still shows loss is not asked for more just because its REMB
// packet went up; the two are only in agreement when the link is clean.
func TestViewerRateDoesNotTrustARisingREMBWhileLosing(t *testing.T) {
	t.Parallel()

	speed := newViewerRate()
	lossReport(&speed, 64, testDelivered)

	lost := speed.limit().bps

	speed.setREMB(testDelivered * 4)

	if got := speed.limit().bps; got > lost*2 {
		t.Fatalf("limit %d after a rising REMB during loss, want it near the lossy estimate %d", got, lost)
	}
}

func TestViewerRateClimbsFromTheFloorEventually(t *testing.T) {
	t.Parallel()

	speed := newViewerRate()

	for range 20 {
		lossReport(&speed, 255, testDelivered)
	}

	if floor := speed.limit().bps; floor != minViewerBitrate {
		t.Fatalf("limit %d after sustained total loss, want the floor %d", floor, minViewerBitrate)
	}

	probing(&speed, 300, time.Minute)

	if got := speed.limit().bps; got < testDelivered {
		t.Fatalf("limit %d after five hours of clean reports, want it back above %d", got, testDelivered)
	}
}
