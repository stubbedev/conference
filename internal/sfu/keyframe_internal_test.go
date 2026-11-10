package sfu

import (
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
)

// forwardedUpTo is a viewer's munger after it was last forwarded the
// packet numbered seq at at.
func forwardedUpTo(seq uint16, at time.Time) munger {
	sent := newMunger()
	sent.applyHeader(rtp.Header{SequenceNumber: seq, Timestamp: uint32(seq) * 3000}, at)

	return sent
}

func reported(seq uint16) receivedUpTo { return receivedUpTo{seq: seq, known: true} }

func TestIdleKeyframeRequestIsOnlyADecoderTimingOutOnAStillStream(t *testing.T) {
	t.Parallel()

	last := time.Unix(1000, 0)
	timedOut := last.Add(3 * time.Second)

	for _, tc := range []struct {
		name     string
		sent     munger
		received receivedUpTo
		now      time.Time
		idle     bool
	}{
		{name: "still, all received", sent: forwardedUpTo(100, last), received: reported(100), now: timedOut, idle: true},
		{name: "still, the last packets lost", sent: forwardedUpTo(100, last), received: reported(97), now: timedOut, idle: false},
		{name: "still, the last packets lost across a wrap", sent: forwardedUpTo(2, last), received: reported(65534), now: timedOut, idle: false},
		{name: "still, nothing reported", sent: forwardedUpTo(100, last), received: unreported, now: timedOut, idle: false},
		{name: "flowing", sent: forwardedUpTo(100, last), received: reported(100), now: last.Add(300 * time.Millisecond), idle: false},
		{name: "nothing forwarded yet", sent: newMunger(), received: reported(0), now: timedOut, idle: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			if got := idleKeyframeRequest(tc.sent, tc.received, tc.now); got != tc.idle {
				t.Fatalf("idle = %v, want %v", got, tc.idle)
			}
		})
	}
}

// TestViewerReportAppliesOnlyItsOwnBlock: a receiver report reaches the
// feedback loop of every track it has a block for, with the blocks of
// the viewer's other tracks in it. Heavy loss on the camera must not
// step the share's viewer down, nor count as the share received.
func TestViewerReportAppliesOnlyItsOwnBlock(t *testing.T) {
	t.Parallel()

	const (
		shareSSRC  = 1111
		cameraSSRC = 2222
	)

	screen := simulcastTrack(trackKey{up: UpstreamScreen, mid: "0"}, KindScreen)
	screen.addViewer("bob", nil, layerHigh)

	viewer := newMember(testRoom("reports"), 1, testJoin("reports", "bob"), func(Message) {})
	viewer.ID = "bob"

	down := &DownPeer{sourceID: "alice", pc: nil, sends: map[trackKey]*downSend{}, ice: newICEStash(), offerPending: false, offerDirty: false}

	var relay feedbackRelay

	report := &rtcp.ReceiverReport{SSRC: 1, Reports: []rtcp.ReceptionReport{{
		SSRC: cameraSSRC, FractionLost: 200, TotalLost: 0, LastSequenceNumber: 42, Jitter: 0, LastSenderReport: 0, Delay: 0,
	}}}

	for range lossyReportsToStep {
		down.relayFeedback(&relay, report, viewer, screen, shareSSRC)
	}

	share := screen.viewers["bob"]
	if share.steps.ceiling != layerHigh || share.received.known {
		t.Fatalf("the camera's report moved the share's viewer: ceiling %d, received %+v",
			share.steps.ceiling, share.received)
	}

	report.Reports[0].SSRC = shareSSRC
	down.relayFeedback(&relay, report, viewer, screen, shareSSRC)

	if share.received != (receivedUpTo{seq: 42, known: true}) {
		t.Fatalf("the share's own block left it at %+v, want sequence 42 received", share.received)
	}
}
