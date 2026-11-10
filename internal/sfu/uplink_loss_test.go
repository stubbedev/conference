package sfu_test

import (
	"fmt"
	"math"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/stubbe/conference/internal/sfu"
)

// lossyUplink is a publisher's uplink that loses video packets while it
// is dropping: two of every three, picked by sequence number.
type lossyUplink struct {
	interceptor.NoOp

	dropping atomic.Bool
}

const lossyUplinkKeeps = 3

//nolint:ireturn // the signature interceptor.Factory sets
func (l *lossyUplink) NewInterceptor(string) (interceptor.Interceptor, error) {
	return l, nil
}

//nolint:ireturn // the signature interceptor.Interceptor sets
func (l *lossyUplink) BindLocalStream(info *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	if !strings.HasPrefix(info.MimeType, "video/") {
		return writer
	}

	return interceptor.RTPWriterFunc(func(header *rtp.Header, payload []byte, attributes interceptor.Attributes) (int, error) {
		if l.dropping.Load() && header.SequenceNumber%lossyUplinkKeeps != 0 {
			return header.MarshalSize() + len(payload), nil
		}

		return writer.Write(header, payload, attributes)
	})
}

func lossyPublisherAPI(t *testing.T, uplink *lossyUplink) *webrtc.API {
	t.Helper()

	mediaEngine := &webrtc.MediaEngine{}

	err := mediaEngine.RegisterDefaultCodecs()
	if err != nil {
		t.Fatalf("register codecs: %v", err)
	}

	registry := &interceptor.Registry{}
	registry.Add(uplink)

	return webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine), webrtc.WithInterceptorRegistry(registry))
}

// A share that scrolls, then sits nearly still: fifty frames a second,
// ten packets each while it scrolls and one each while it idles.
const (
	shareFrameInterval = 20 * time.Millisecond
	scrollFrameBytes   = 12_000
	idleFrameBytes     = 1000
	idleSendRate       = idleFrameBytes * 8 * float64(time.Second/shareFrameInterval)
)

// sharePhase is one stretch of the share's life.
type sharePhase struct {
	frameBytes int
	lossy      bool
	lasts      time.Duration
}

// present sends the share through its phases, losing packets in the
// lossy ones.
func (l *lossyUplink) present(track *webrtc.TrackLocalStaticSample, phases ...sharePhase) error {
	ticker := time.NewTicker(shareFrameInterval)
	defer ticker.Stop()

	for _, phase := range phases {
		l.dropping.Store(phase.lossy)

		frame := media.Sample{Data: make([]byte, phase.frameBytes), Duration: shareFrameInterval}

		for end := time.Now().Add(phase.lasts); time.Now().Before(end); <-ticker.C {
			err := track.WriteSample(frame)
			if err != nil {
				return fmt.Errorf("share frame of %d bytes: %w", phase.frameBytes, err)
			}
		}
	}

	return nil
}

// TestLossOnAnIdleShareDoesNotPinItsRemb scrolls a share over a clean
// uplink, then loses two thirds of its packets for two seconds while it
// idles. What gets through those seconds is a sixth of a megabit, and a
// REMB backed off from that would hold the next scroll below what the
// share sends sitting still.
func TestLossOnAnIdleShareDoesNotPinItsRemb(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	t.Cleanup(closeEngine)

	uplink := &lossyUplink{NoOp: interceptor.NoOp{}, dropping: atomic.Bool{}}
	publisher := newTestPeer(t, newTestHub(t, engine), engine, "alice", false)
	sent := publishOn(t, lossyPublisherAPI(t, uplink), publisher, sfu.UpstreamScreen, screenAudioID, screenID)
	rembs := watchRembOnPublisher(sent[screenID].sender)

	waitPublisherConnected(t, publisher.localPC(sfu.UpstreamScreen.PCID()))

	presented := make(chan error, 1)

	go func() {
		presented <- uplink.present(sent[screenID].track,
			sharePhase{frameBytes: scrollFrameBytes, lossy: false, lasts: 1500 * time.Millisecond},
			sharePhase{frameBytes: idleFrameBytes, lossy: true, lasts: 2200 * time.Millisecond},
			sharePhase{frameBytes: idleFrameBytes, lossy: false, lasts: 1200 * time.Millisecond},
		)
	}()

	lowest := math.Inf(1)

	for {
		select {
		case bitrate, open := <-rembs:
			if !open {
				t.Fatal("the publisher's RTCP reader closed while the share was presenting")
			}

			lowest = min(lowest, bitrate)

			continue
		case err = <-presented:
		}

		break
	}

	if err != nil {
		t.Fatal(err)
	}

	if lowest >= sfu.BrowserMaxBitrate {
		t.Fatalf("lowest REMB %.0f, want a limit: the loss never reached the server and the test proves nothing", lowest)
	}

	if lowest < idleSendRate {
		t.Fatalf("lowest REMB %.0f after loss on the idle share, want it above the %.0f the share sends sitting still", lowest, idleSendRate)
	}
}
