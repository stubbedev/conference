package sfu

import (
	"testing"
	"time"
)

const (
	testDelivered = 2_500_000

	// reportPackets is how many packets a test viewer's report covers
	// unless the test says otherwise: plenty to tell a loss rate, and a
	// count of lost packets among them is their fraction in 1/256.
	reportPackets = fractionScale
)

// reportingViewer is a viewer whose receiver reports a test writes. It
// keeps the cumulative counts a receiver keeps, so every report continues
// the one before it.
type reportingViewer struct {
	rate  viewerRate
	count reportedCount
}

// newReportingViewer is a viewer that has sent its first report, the one
// its counts start from.
func newReportingViewer() *reportingViewer {
	viewer := &reportingViewer{rate: newViewerRate(), count: reportedCount{highest: 1000, lost: 0, known: true}}
	viewer.rate.updateLoss(viewer.count, rateGainPeriod, 0)

	return viewer
}

// report sends one report elapsed after the previous one: of packets
// more packets the viewer lost lost, while the track arrived at
// delivered bits per second.
func (v *reportingViewer) report(packets, lost uint32, elapsed time.Duration, delivered uint64) {
	v.count.highest += packets
	v.count.lost += lost
	v.rate.updateLoss(v.count, elapsed, delivered)
}

// lossReport sends one report of the given fraction lost, a second after
// the previous one, the way a viewer reports.
func (v *reportingViewer) lossReport(fractionLost uint8, delivered uint64) {
	v.report(reportPackets, uint32(fractionLost), rateGainPeriod, delivered)
}

// probing sends clean reports while the viewer is sent all its estimate
// allows, the way a single-layer stream held back by it is.
func (v *reportingViewer) probing(reports int, elapsed time.Duration) {
	for range reports {
		v.report(reportPackets, 0, elapsed, v.rate.limit().bps)
	}
}

func TestViewerRateLimitsNothingBeforeLoss(t *testing.T) {
	t.Parallel()

	viewer := newReportingViewer()
	viewer.lossReport(0, testDelivered)

	if got := viewer.rate.limit(); got.bound {
		t.Fatalf("limit %d before any loss or REMB, want none", got.bps)
	}
}

// TestViewerRateIgnoresLossBeforeAnythingWasDelivered: a report that
// arrives before the track was measured for a full period has no rate to
// back off from, and must not throw the viewer to the floor.
func TestViewerRateIgnoresLossBeforeAnythingWasDelivered(t *testing.T) {
	t.Parallel()

	viewer := newReportingViewer()
	viewer.lossReport(255, 0)

	if got := viewer.rate.limit(); got.bound {
		t.Fatalf("limit %d from loss before anything was delivered, want none", got.bps)
	}
}

func TestViewerRateDropsOnLoss(t *testing.T) {
	t.Parallel()

	viewer := newReportingViewer()
	viewer.lossReport(64, testDelivered)

	if got := viewer.rate.limit(); !got.bound || got.bps >= testDelivered {
		t.Fatalf("limit %+v after 25%% loss, want it below the %d delivered", got, testDelivered)
	}

	for range 10 {
		viewer.lossReport(255, testDelivered)
	}

	if got := viewer.rate.limit().bps; got > 100_000 {
		t.Fatalf("limit %d after sustained total loss, want it near the floor", got)
	}
}

// TestViewerRateWaitsForEnoughPackets: a viewer of a still screen gets a
// handful of packets between two reports, and one lost among them reads
// as a quarter lost. Reports that few packets tell nothing by themselves
// and change nothing.
func TestViewerRateWaitsForEnoughPackets(t *testing.T) {
	t.Parallel()

	viewer := newReportingViewer()
	viewer.lossReport(0, burstRate)

	for range minLossPackets/stillPackets - 1 {
		viewer.report(stillPackets, 1, rateGainPeriod, stillRate)
	}

	if got := viewer.rate.limit(); got.bound {
		t.Fatalf("limit %d from reports of %d packets each, want none before %d packets are reported",
			got.bps, stillPackets, minLossPackets)
	}
}

// TestViewerRateGathersSmallReports: loss that lasts shows once the
// small reports together cover enough packets, and is then loss of a
// screen that sent little. It lowers the estimate from what the viewer
// was delivered at its best, not to what a still screen sends: the next
// scroll would be held to that.
func TestViewerRateGathersSmallReports(t *testing.T) {
	t.Parallel()

	viewer := newReportingViewer()
	viewer.lossReport(0, burstRate)

	for range minLossPackets / stillPackets {
		viewer.report(stillPackets, 1, rateGainPeriod, stillRate)
	}

	want := capAt(backOff(burstRate, fractionScale/stillPackets))
	if got := viewer.rate.limit(); got != want {
		t.Fatalf("limit %+v after a quarter of a still screen's packets were lost, want %+v, the back-off from the %d delivered before",
			got, want, burstRate)
	}
}

// TestViewerLossWhileIdleBacksOffFromTheLimit: with a limit in place,
// loss while the viewer is sent little of it lowers that limit, and does
// not replace it with the little that got through.
func TestViewerLossWhileIdleBacksOffFromTheLimit(t *testing.T) {
	t.Parallel()

	viewer := newReportingViewer()
	viewer.lossReport(64, burstRate)

	limited := viewer.rate.limit()

	viewer.lossReport(128, stillRate)

	want := capAt(backOff(limited.bps, 128))
	if got := viewer.rate.limit(); got != want {
		t.Fatalf("limit %+v after loss on a still screen under a limit of %d, want %+v, the back-off from the limit",
			got, limited.bps, want)
	}
}

// TestViewerLossAtTheLimitBacksOffToWhatGotThrough: a viewer that is
// sent all its limit allows and loses half of it has shown what its link
// carries.
func TestViewerLossAtTheLimitBacksOffToWhatGotThrough(t *testing.T) {
	t.Parallel()

	viewer := newReportingViewer()
	viewer.lossReport(64, burstRate)

	limited := viewer.rate.limit()

	viewer.lossReport(128, limited.bps)

	want := capAt(backOff(limited.bps/2, 128))
	if got := viewer.rate.limit(); got != want {
		t.Fatalf("limit %+v after losing half of what a limit of %d allows, want %+v, the back-off from the half that got through",
			got, limited.bps, want)
	}
}

// TestViewerRateCountsAcrossALostReport: a receiver report is one
// datagram and can be lost like any other. The next one covers the
// packets of both, so the viewer's loss is not missed with it.
func TestViewerRateCountsAcrossALostReport(t *testing.T) {
	t.Parallel()

	every := newReportingViewer()
	every.lossReport(64, testDelivered)
	every.lossReport(64, testDelivered)

	missed := newReportingViewer()
	missed.count.highest += reportPackets
	missed.count.lost += 64
	missed.report(reportPackets, 64, 2*rateGainPeriod, testDelivered)

	if got := missed.rate.limit(); !got.bound || got.bps >= testDelivered {
		t.Fatalf("limit %+v after a report that followed a lost one, want it below the %d delivered", got, testDelivered)
	}
}

// TestViewerRateStartsOverWithTheReceiver: a receiver that started over
// counts from nothing again. Its first report says where, and is not a
// period in which every packet since the old count was lost or found.
func TestViewerRateStartsOverWithTheReceiver(t *testing.T) {
	t.Parallel()

	viewer := newReportingViewer()
	viewer.lossReport(0, testDelivered)

	viewer.count = reportedCount{highest: 10, lost: 200, known: true}
	viewer.rate.updateLoss(viewer.count, rateGainPeriod, testDelivered)

	if got := viewer.rate.limit(); got.bound {
		t.Fatalf("limit %d from the first report of a receiver that started over, want none", got.bps)
	}

	viewer.lossReport(64, testDelivered)

	if got := viewer.rate.limit(); !got.bound {
		t.Fatal("no limit after loss the restarted receiver reported, want its reports counted from the restart")
	}
}

func TestReportedSince(t *testing.T) {
	t.Parallel()

	count := func(highest, lost uint32) reportedCount {
		return reportedCount{highest: highest, lost: lost, known: true}
	}

	packets := func(expected, received uint64) receiveTotals {
		return receiveTotals{bytes: 0, expected: expected, received: received}
	}

	const minusTwo = 1<<lostBits - 2

	for _, tc := range []struct {
		name      string
		earlier   reportedCount
		later     reportedCount
		want      receiveTotals
		continues bool
	}{
		{name: "the first report", earlier: nothingReported, later: count(500, 3), want: noPackets, continues: false},
		{name: "a quarter lost", earlier: count(500, 3), later: count(600, 28), want: packets(100, 75), continues: true},
		{name: "nothing new", earlier: count(500, 3), later: count(500, 3), want: packets(0, 0), continues: true},
		{name: "a lost packet arrived after all", earlier: count(500, 8), later: count(600, 3), want: packets(100, 105), continues: true},
		{name: "the sequence number wrapped", earlier: count(1<<32-16, 0), later: count(16, 8), want: packets(32, 24), continues: true},
		{name: "a negative loss count", earlier: count(500, minusTwo), later: count(600, 3), want: packets(100, 95), continues: true},
		{name: "more lost than expected", earlier: count(500, 0), later: count(510, 40), want: packets(10, 0), continues: true},
		{name: "the receiver started over", earlier: count(500, 3), later: count(20, 0), want: noPackets, continues: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got, continues := tc.later.since(tc.earlier)
			if got != tc.want || continues != tc.continues {
				t.Fatalf("got %+v (continues %v), want %+v (continues %v)", got, continues, tc.want, tc.continues)
			}
		})
	}
}

// TestViewerRateRecoversOnItsOwn is the upward half of the controller: a
// viewer that lost packets and then reports a clean link must climb back
// above what it was sent before, or a single-layer stream stays degraded
// by an old blip for the rest of the call.
func TestViewerRateRecoversOnItsOwn(t *testing.T) {
	t.Parallel()

	viewer := newReportingViewer()
	viewer.lossReport(64, testDelivered)

	dropped := viewer.rate.limit().bps

	viewer.probing(30, rateGainPeriod)

	if got := viewer.rate.limit().bps; got <= testDelivered {
		t.Fatalf("limit %d after half a minute of clean reports, want it back above %d (was %d)", got, testDelivered, dropped)
	}
}

// TestViewerRateGrowsOnlyWhileProbing: a viewer sent far less than its
// estimate is not testing the link, so a clean report says nothing about
// more room and must not walk the estimate away from what was delivered.
func TestViewerRateGrowsOnlyWhileProbing(t *testing.T) {
	t.Parallel()

	viewer := newReportingViewer()
	viewer.lossReport(64, testDelivered)

	held := viewer.rate.limit().bps

	for range 60 {
		viewer.lossReport(0, held/4)
	}

	if got := viewer.rate.limit().bps; got != held {
		t.Fatalf("limit %d after a minute of clean reports at a quarter of it, want it held at %d", got, held)
	}
}

// TestViewerRateRecoveryIsPacedByTime: the same number of reports at the
// same spacing has to climb by the same amount, so a viewer reporting
// every 200 ms does not recover five times slower than one reporting
// every second.
func TestViewerRateRecoveryIsPacedByTime(t *testing.T) {
	t.Parallel()

	fast := newReportingViewer()
	slow := newReportingViewer()

	for _, viewer := range []*reportingViewer{fast, slow} {
		viewer.lossReport(64, testDelivered)
	}

	base := fast.rate.limit().bps

	fast.probing(10, rateGainPeriod/5)
	slow.probing(10, rateGainPeriod)

	got, want := fast.rate.limit().bps, slow.rate.limit().bps
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

	viewer := newReportingViewer()
	viewer.lossReport(64, testDelivered)
	viewer.rate.setREMB(300_000)

	if got := viewer.rate.limit().bps; got > 300_000 {
		t.Fatalf("limit %d after the viewer capped itself, want at most 300000", got)
	}

	viewer.lossReport(0, 300_000)
	viewer.rate.setREMB(testDelivered)

	if got := viewer.rate.limit().bps; got != testDelivered {
		t.Fatalf("limit %d after the viewer's REMB recovered, want its REMB %d", got, testDelivered)
	}
}

// TestViewerRateDoesNotTrustARisingREMBWhileLosing: a viewer whose last
// report still shows loss is not asked for more just because its REMB
// packet went up; the two are only in agreement when the link is clean.
func TestViewerRateDoesNotTrustARisingREMBWhileLosing(t *testing.T) {
	t.Parallel()

	viewer := newReportingViewer()
	viewer.lossReport(64, testDelivered)

	lost := viewer.rate.limit().bps

	viewer.rate.setREMB(testDelivered * 4)

	if got := viewer.rate.limit().bps; got > lost*2 {
		t.Fatalf("limit %d after a rising REMB during loss, want it near the lossy estimate %d", got, lost)
	}
}

func TestViewerRateClimbsFromTheFloorEventually(t *testing.T) {
	t.Parallel()

	viewer := newReportingViewer()

	for range 20 {
		viewer.lossReport(255, testDelivered)
	}

	if floor := viewer.rate.limit().bps; floor != minViewerBitrate {
		t.Fatalf("limit %d after sustained total loss, want the floor %d", floor, minViewerBitrate)
	}

	viewer.probing(300, time.Minute)

	if got := viewer.rate.limit().bps; got < testDelivered {
		t.Fatalf("limit %d after five hours of clean reports, want it back above %d", got, testDelivered)
	}
}
