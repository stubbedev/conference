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

// resumedAfter is a viewer's munger after it was forwarded up to the
// packet numbered seq at paused, nothing until resumed, and then the two
// packets of the next frame.
func resumedAfter(seq uint16, paused, resumed time.Time) munger {
	sent := forwardedUpTo(seq, paused)
	frame := (uint32(seq) + 1) * 3000

	sent.applyHeader(rtp.Header{SequenceNumber: seq + 1, Timestamp: frame}, resumed)
	sent.applyHeader(rtp.Header{SequenceNumber: seq + 2, Timestamp: frame}, resumed.Add(time.Millisecond))

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
		{
			name: "resumed a moment ago, all before the pause received",
			sent: resumedAfter(100, last, timedOut), received: reported(100), now: timedOut.Add(50 * time.Millisecond), idle: true,
		},
		{
			name: "resumed a moment ago, the report reaches into the new frames",
			sent: resumedAfter(100, last, timedOut), received: reported(101), now: timedOut.Add(900 * time.Millisecond), idle: true,
		},
		{
			name: "resumed a moment ago, the last packets before the pause lost",
			sent: resumedAfter(100, last, timedOut), received: reported(97), now: timedOut.Add(50 * time.Millisecond), idle: false,
		},
		{
			name: "resumed a moment ago across a wrap, all before the pause received",
			sent: resumedAfter(65535, last, timedOut), received: reported(65535), now: timedOut.Add(50 * time.Millisecond), idle: true,
		},
		{
			name: "resumed a moment ago across a wrap, the last packets before the pause lost",
			sent: resumedAfter(65535, last, timedOut), received: reported(65533), now: timedOut.Add(50 * time.Millisecond), idle: false,
		},
		{
			name: "resumed a moment ago, nothing reported",
			sent: resumedAfter(100, last, timedOut), received: unreported, now: timedOut.Add(50 * time.Millisecond), idle: false,
		},
		{
			name: "resumed after a pause too short to time a decoder out",
			sent: resumedAfter(100, last, last.Add(1500*time.Millisecond)), received: reported(100),
			now: last.Add(1550 * time.Millisecond), idle: false,
		},
		{
			name: "resumed, and flowing for longer than the grace",
			sent: resumedAfter(100, last, timedOut), received: reported(100), now: timedOut.Add(resumeGrace), idle: false,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			if got := idleKeyframeRequest(tc.sent, tc.received, tc.now); got != tc.idle {
				t.Fatalf("idle = %v, want %v", got, tc.idle)
			}
		})
	}
}

// TestKeyframeRequestRepeatedAfterAPauseEndedIsRelayed: the request that
// crosses the first frames after a pause is the timeout the pause set
// off. A viewer that cannot decode those frames asks again, on either of
// libwebrtc's schedules, and must get its keyframe then.
func TestKeyframeRequestRepeatedAfterAPauseEndedIsRelayed(t *testing.T) {
	t.Parallel()

	const (
		decoderAsksEvery  = 200 * time.Millisecond
		receiverAsksAfter = 3 * time.Second
	)

	paused := time.Unix(1000, 0)
	resumed := paused.Add(receiverAsksAfter)
	sent := resumedAfter(100, paused, resumed)
	holdsThePause := reported(100)

	if !idleKeyframeRequest(sent, holdsThePause, resumed.Add(20*time.Millisecond)) {
		t.Fatal("the request that crossed the first frames after the pause was relayed")
	}

	if idleKeyframeRequest(sent, holdsThePause, resumed.Add(receiverAsksAfter)) {
		t.Fatal("a receiver still without a decodable frame one timeout later was not given its keyframe")
	}

	var waited time.Duration
	for waited = decoderAsksEvery; idleKeyframeRequest(sent, holdsThePause, resumed.Add(waited)); waited += decoderAsksEvery {
		if waited > receiverAsksAfter {
			t.Fatal("a decoder asking every 200 ms was never given its keyframe")
		}
	}

	if waited > resumeGrace {
		t.Fatalf("a decoder asking every 200 ms waited %v for its keyframe, want at most %v", waited, resumeGrace)
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

	down := newDownPeer("alice", nil)

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
