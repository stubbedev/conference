package sfu_test

import (
	"strings"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"

	"github.com/stubbe/conference/internal/sfu"
)

const transportCCURI = "http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01"

func twccPublisherAPI(t *testing.T) *webrtc.API {
	t.Helper()

	mediaEngine := &webrtc.MediaEngine{}

	err := mediaEngine.RegisterDefaultCodecs()
	if err != nil {
		t.Fatalf("register codecs: %v", err)
	}

	mediaEngine.RegisterFeedback(webrtc.RTCPFeedback{Type: webrtc.TypeRTCPFBTransportCC, Parameter: ""}, webrtc.RTPCodecTypeVideo)

	registry := &interceptor.Registry{}

	err = webrtc.ConfigureTWCCHeaderExtensionSender(mediaEngine, registry)
	if err != nil {
		t.Fatalf("transport-wide sequence numbers: %v", err)
	}

	return webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine), webrtc.WithInterceptorRegistry(registry))
}

func watchRTCP[P rtcp.Packet](sender *webrtc.RTPSender) <-chan struct{} {
	feedback := make(chan struct{}, 1)

	go func() {
		for {
			packets, _, err := sender.ReadRTCP()
			if err != nil {
				return
			}

			for _, packet := range packets {
				if _, ok := packet.(P); ok {
					select {
					case feedback <- struct{}{}:
					default:
					}
				}
			}
		}
	}()

	return feedback
}

func TestPublisherReceivesTransportWideFeedback(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := newTestHub(t, engine)
	publisher := newTestPeer(t, hub, engine, "alice", false)

	publisherPC, err := twccPublisherAPI(t).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("publisher pc: %v", err)
	}

	attachUp(publisher, sfu.UpstreamMedia, publisherPC)

	video := newSampleTrack(t, webrtc.MimeTypeVP8, "video")

	sender, err := publisherPC.AddTrack(video)
	if err != nil {
		t.Fatalf("add video: %v", err)
	}

	negotiateUp(t, publisher, sfu.UpstreamMedia, publisherPC)

	if !strings.Contains(publisherPC.RemoteDescription().SDP, transportCCURI) {
		t.Fatal("the server's answer to a publisher does not negotiate transport-wide sequence numbers")
	}

	feedback := watchRTCP[*rtcp.TransportLayerCC](sender)

	go pumpMedia(video)

	select {
	case <-feedback:
	case <-time.After(testTimeout):
		t.Fatal("the publisher never received transport-wide congestion feedback")
	}
}

func TestViewerOfferLeavesOutTransportWideFeedback(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := newTestHub(t, engine)

	publisher := newTestPeer(t, hub, engine, "alice", false)
	audio, video := publisherOffer(t, publisher)

	go pumpMedia(audio)
	go pumpMedia(video)

	viewer := newTestPeer(t, hub, engine, "bob", false)
	viewerSubscribe(t, viewer, engine)

	offer := viewer.localPC(downID(publisher)).RemoteDescription().SDP
	if strings.Contains(offer, transportCCURI) || strings.Contains(offer, webrtc.TypeRTCPFBTransportCC) {
		t.Fatal("the server asks a viewer for transport-wide feedback it has no congestion controller to use")
	}
}
