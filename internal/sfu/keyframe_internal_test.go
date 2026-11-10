package sfu

import (
	"testing"

	"github.com/pion/rtcp"
)

// TestViewerReportAppliesOnlyItsOwnBlock: a receiver report reaches the
// feedback loop of every track it has a block for, with the blocks of
// the viewer's other tracks in it. Heavy loss on the camera must not
// step the share's viewer down.
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
	if share.steps.ceiling != layerHigh {
		t.Fatalf("the camera's report moved the share's viewer: ceiling %d", share.steps.ceiling)
	}

	report.Reports[0].SSRC = shareSSRC

	for range lossyReportsToStep {
		down.relayFeedback(&relay, report, viewer, screen, shareSSRC)
	}

	if share.steps.ceiling == layerHigh {
		t.Fatal("the share's own report left its viewer at the top layer")
	}
}
