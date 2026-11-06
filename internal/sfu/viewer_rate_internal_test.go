package sfu

import (
	"testing"
	"time"
)

const testCeiling = 2_500_000

func newTestViewerRate() viewerRate {
	return newViewerRate(testCeiling)
}

// lossReport applies one receiver report of the given fraction lost,
// spaced a second apart the way a viewer reports.
func lossReport(speed *viewerRate, fractionLost uint8) {
	speed.updateLoss(fractionLost, rateGainPeriod)
}

func TestViewerRateStartsAtTheCeiling(t *testing.T) {
	t.Parallel()

	speed := newTestViewerRate()

	if got := speed.max(); got != testCeiling {
		t.Fatalf("rate %d before any report, want the ceiling %d", got, testCeiling)
	}
}

func TestViewerRateDropsOnLoss(t *testing.T) {
	t.Parallel()

	speed := newTestViewerRate()
	lossReport(&speed, 64)

	if got := speed.max(); got >= testCeiling {
		t.Fatalf("rate %d after 25%% loss, want it below the ceiling", got)
	}

	for range 10 {
		lossReport(&speed, 255)
	}

	if got := speed.max(); got > 100_000 {
		t.Fatalf("rate %d after sustained total loss, want it near the floor", got)
	}
}

// TestViewerRateRecoversOnItsOwn is the upward half of the controller: a
// viewer that lost packets and then reports a clean link must climb back
// to the ceiling, or a screen share stays blurred by an old blip for the
// rest of the call.
func TestViewerRateRecoversOnItsOwn(t *testing.T) {
	t.Parallel()

	speed := newTestViewerRate()
	lossReport(&speed, 64)

	dropped := speed.max()

	for range 120 {
		lossReport(&speed, 0)

		if speed.max() == testCeiling {
			return
		}
	}

	t.Fatalf("rate %d after two minutes of clean reports, want the ceiling %d (was %d)", speed.max(), testCeiling, dropped)
}

// TestViewerRateRecoveryIsPacedByTime: the same number of reports at the
// same spacing has to climb by the same amount, so a viewer reporting
// every 200 ms does not recover five times slower than one reporting
// every second.
func TestViewerRateRecoveryIsPacedByTime(t *testing.T) {
	t.Parallel()

	fast := newTestViewerRate()
	slow := newTestViewerRate()

	for _, speed := range []*viewerRate{&fast, &slow} {
		lossReport(speed, 64)
	}

	base := fast.max()

	for range 10 {
		fast.updateLoss(0, rateGainPeriod/5)
		slow.updateLoss(0, rateGainPeriod)
	}

	if fast.max() <= base || slow.max() <= base {
		t.Fatalf("rates %d and %d after clean reports, want both above %d", fast.max(), slow.max(), base)
	}

	if fast.max() > slow.max()*2 || slow.max() > fast.max()*2 {
		t.Fatalf("rates %d (five reports a second) and %d (one a second) recovered at different paces", fast.max(), slow.max())
	}
}

// TestViewerRateNeverExceedsTheCeiling guards the additive ramp: the room
// ceiling is what the publisher may send, so a long clean call must not
// talk the SFU into asking for more than that.
func TestViewerRateNeverExceedsTheCeiling(t *testing.T) {
	t.Parallel()

	speed := newTestViewerRate()

	for range 500 {
		lossReport(&speed, 0)
	}

	if got := speed.max(); got != testCeiling {
		t.Fatalf("rate %d after ten minutes of clean reports, want the ceiling %d", got, testCeiling)
	}
}

// TestViewerRateFollowsARisingREMB is the fast path back up: once the
// viewer says its downlink is healthy again, the publisher gets its
// ceiling back on that report instead of creeping up at 5% a second.
func TestViewerRateFollowsARisingREMB(t *testing.T) {
	t.Parallel()

	speed := newTestViewerRate()
	lossReport(&speed, 64)
	speed.setREMB(300_000)

	if got := speed.max(); got > 300_000 {
		t.Fatalf("rate %d after the viewer capped itself, want at most 300000", got)
	}

	lossReport(&speed, 0)
	speed.setREMB(testCeiling)

	if got := speed.max(); got != testCeiling {
		t.Fatalf("rate %d after the viewer's REMB recovered, want the ceiling %d", got, testCeiling)
	}
}

// TestViewerRateDoesNotTrustARisingREMBWhileLosing: a viewer whose last
// report still shows loss is not asked for more just because its REMB
// packet went up; the two are only in agreement when the link is clean.
func TestViewerRateDoesNotTrustARisingREMBWhileLosing(t *testing.T) {
	t.Parallel()

	speed := newTestViewerRate()
	lossReport(&speed, 64)

	lost := speed.max()

	speed.setREMB(testCeiling)

	if got := speed.max(); got > lost*2 {
		t.Fatalf("rate %d after a rising REMB during loss, want it near the lossy estimate %d", got, lost)
	}
}

func TestViewerRateClimbsFromTheFloorEventually(t *testing.T) {
	t.Parallel()

	speed := newTestViewerRate()

	for range 20 {
		lossReport(&speed, 255)
	}

	floor := speed.max()
	if floor != minViewerBitrate {
		t.Fatalf("rate %d after sustained total loss, want the floor %d", floor, minViewerBitrate)
	}

	for range 300 {
		speed.updateLoss(0, time.Minute)
	}

	if got := speed.max(); got != testCeiling {
		t.Fatalf("rate %d after five hours of clean reports, want the ceiling %d", got, testCeiling)
	}
}
