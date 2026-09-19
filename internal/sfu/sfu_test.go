package sfu_test

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/stubbe/conference/internal/sfu"
)

const (
	testSlug      = "integration-room"
	testTimeout   = 15 * time.Second
	readTimeout   = 10 * time.Second
	frameInterval = 33 * time.Millisecond
	frameBytes    = 1200
)

// testPeer wires one test-side peer connection to one hub member. The
// pump goroutine applies the server's ICE candidates to the local peer
// (buffering them until its remote description exists) and forwards
// every other message to out for the test to inspect.
type testPeer struct {
	member  *sfu.Member
	engine  *sfu.Engine
	raw     chan sfu.Message
	out     chan sfu.Message
	local   *webrtc.PeerConnection
	mu      sync.Mutex
	pending []webrtc.ICECandidateInit
}

func newTestPeer(t *testing.T, hub *sfu.Hub, engine *sfu.Engine, name string) *testPeer {
	t.Helper()

	peer := &testPeer{
		member:  nil,
		engine:  engine,
		raw:     make(chan sfu.Message, 256),
		out:     make(chan sfu.Message, 64),
		local:   nil,
		mu:      sync.Mutex{},
		pending: nil,
	}

	var err error

	peer.member, err = hub.JoinRoom(sfu.JoinRequest{
		Slug:       testSlug,
		RoomName:   "Integration",
		MemberName: name,
		E2EE:       true,
		MaxMembers: 8,
	}, func(msg sfu.Message) { peer.raw <- msg })
	if err != nil {
		t.Fatalf("%s join: %v", name, err)
	}

	go peer.pump()

	return peer
}

func (p *testPeer) pump() {
	for msg := range p.raw {
		if msg.Type == "ice" {
			p.addICE(msg)

			continue
		}

		p.out <- msg
	}
}

func (p *testPeer) addICE(msg sfu.Message) {
	if msg.Candidate == nil || p.local == nil {
		return
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	if p.local.RemoteDescription() == nil {
		p.pending = append(p.pending, *msg.Candidate)

		return
	}

	_ = p.local.AddICECandidate(*msg.Candidate)
}

func (p *testPeer) setRemote(desc webrtc.SessionDescription) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	err := p.local.SetRemoteDescription(desc)
	if err != nil {
		return fmt.Errorf("test peer: set remote description: %w", err)
	}

	for _, candidate := range p.pending {
		_ = p.local.AddICECandidate(candidate)
	}

	p.pending = nil

	return nil
}

// next returns the next non-ICE message, failing the test on timeout.
func (p *testPeer) next(t *testing.T, msgType string) sfu.Message {
	t.Helper()

	deadline := time.After(testTimeout)

	for {
		select {
		case msg := <-p.out:
			if msg.Type == msgType {
				return msg
			}
		case <-deadline:
			t.Fatalf("timed out waiting for a %q message", msgType)
		}
	}
}

func onICECandidate(member *sfu.Member, pcID string) func(*webrtc.ICECandidate) {
	return func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			return
		}

		init := candidate.ToJSON()

		member.Handle(sfu.Message{Type: "ice", PC: pcID, Candidate: &init})
	}
}

func addPublisherTracks(
	t *testing.T,
	peerConn *webrtc.PeerConnection,
) (*webrtc.TrackLocalStaticSample, *webrtc.TrackLocalStaticSample) {
	t.Helper()

	audio, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "audio", "publisher")
	if err != nil {
		t.Fatalf("audio track: %v", err)
	}

	video, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video", "publisher")
	if err != nil {
		t.Fatalf("video track: %v", err)
	}

	for _, track := range []webrtc.TrackLocal{audio, video} {
		_, err = peerConn.AddTrack(track)
		if err != nil {
			t.Fatalf("add track: %v", err)
		}
	}

	return audio, video
}

func negotiateUp(t *testing.T, publisher *testPeer, peerConn *webrtc.PeerConnection) {
	t.Helper()

	offer, err := peerConn.CreateOffer(nil)
	if err != nil {
		t.Fatalf("publisher offer: %v", err)
	}

	err = peerConn.SetLocalDescription(offer)
	if err != nil {
		t.Fatalf("publisher sld: %v", err)
	}

	var tracks []sfu.TrackInfo

	for _, transceiver := range peerConn.GetTransceivers() {
		sent := transceiver.Sender().Track()

		if transceiver.Mid() == "" || sent == nil {
			continue
		}

		kind := "camera"
		if sent.Kind() == webrtc.RTPCodecTypeAudio {
			kind = "audio"
		}

		tracks = append(tracks, sfu.TrackInfo{Mid: transceiver.Mid(), Kind: kind})
	}

	publisher.member.Handle(sfu.Message{Type: "offer", SDP: offer.SDP, Tracks: tracks})

	answer := publisher.next(t, "answer")

	err = publisher.setRemote(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer.SDP})
	if err != nil {
		t.Fatalf("publisher srd: %v", err)
	}
}

// publisherOffer negotiates the publisher's upstream connection with
// one audio and one video track and returns both writers.
func publisherOffer(
	t *testing.T,
	publisher *testPeer,
) (*webrtc.TrackLocalStaticSample, *webrtc.TrackLocalStaticSample) {
	t.Helper()

	peerConn, err := publisher.engine.NewPeerConnection()
	if err != nil {
		t.Fatalf("publisher pc: %v", err)
	}

	publisher.local = peerConn
	peerConn.OnICECandidate(onICECandidate(publisher.member, "up"))

	audio, video := addPublisherTracks(t, peerConn)
	negotiateUp(t, publisher, peerConn)

	return audio, video
}

// pumpMedia writes dummy frames until the track fails, so the hub sees
// packets and registers the publisher's tracks.
func pumpMedia(track *webrtc.TrackLocalStaticSample) {
	ticker := time.NewTicker(frameInterval)
	defer ticker.Stop()

	sample := media.Sample{Data: make([]byte, frameBytes), Duration: frameInterval}

	for range ticker.C {
		err := track.WriteSample(sample)
		if err != nil {
			return
		}
	}
}

func onDownOffer(t *testing.T, viewer *testPeer, peerConn *webrtc.PeerConnection, offer sfu.Message) {
	t.Helper()

	err := viewer.setRemote(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP})
	if err != nil {
		t.Fatalf("viewer srd: %v", err)
	}

	answer, err := peerConn.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("viewer answer: %v", err)
	}

	err = peerConn.SetLocalDescription(answer)
	if err != nil {
		t.Fatalf("viewer sld: %v", err)
	}

	viewer.member.Handle(sfu.Message{Type: "answer", PC: offer.PC, SDP: peerConn.LocalDescription().SDP})

	sourceID := strings.TrimPrefix(offer.PC, "down-")

	viewer.member.Handle(sfu.Message{Type: "pli", Member: sourceID})
}

// viewerPC lazily creates the viewer's answering peer connection.
func viewerPC(
	t *testing.T,
	viewer *testPeer,
	engine *sfu.Engine,
	existing *webrtc.PeerConnection,
	offer sfu.Message,
	kinds chan<- *webrtc.TrackRemote,
) *webrtc.PeerConnection {
	t.Helper()

	if existing != nil {
		return existing
	}

	subscribed, err := engine.NewPeerConnection()
	if err != nil {
		t.Fatalf("viewer pc: %v", err)
	}

	viewer.local = subscribed
	subscribed.OnICECandidate(onICECandidate(viewer.member, offer.PC))
	subscribed.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		kinds <- track
	})

	return subscribed
}

func isDownOffer(offer sfu.Message) bool {
	return offer.Type == "offer" && strings.HasPrefix(offer.PC, "down-")
}

// viewerSubscribe answers every downstream offer on the same peer
// connection (the hub renegotiates as the publisher's tracks register
// one by one) until both a video and an audio track have arrived.
func viewerSubscribe(
	t *testing.T,
	viewer *testPeer,
	engine *sfu.Engine,
) (*webrtc.TrackRemote, *webrtc.TrackRemote) {
	t.Helper()

	kinds := make(chan *webrtc.TrackRemote, 4)

	var peerConn *webrtc.PeerConnection

	var videoTrack, audioTrack *webrtc.TrackRemote

	videoOK, audioOK := false, false

	deadline := time.After(testTimeout)

	for !videoOK || !audioOK {
		select {
		case offer := <-viewer.out:
			if !isDownOffer(offer) {
				continue
			}

			peerConn = viewerPC(t, viewer, engine, peerConn, offer, kinds)

			onDownOffer(t, viewer, peerConn, offer)
		case track := <-kinds:
			if track.Kind() == webrtc.RTPCodecTypeVideo {
				videoTrack, videoOK = track, true
			}

			if track.Kind() == webrtc.RTPCodecTypeAudio {
				audioTrack, audioOK = track, true
			}
		case <-deadline:
			t.Fatalf("timed out subscribing (video %v, audio %v)", videoOK, audioOK)
		}
	}

	return videoTrack, audioTrack
}

// TestMediaLoopback pushes real RTP from a publisher through the hub
// and asserts that a viewer who joined before the media started both
// negotiates and receives packets.
func TestMediaLoopback(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewEngine(0, nil)
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := sfu.NewHub(sfu.HubConfig{
		Engine:         engine,
		MaxMembers:     8,
		MaxPublishKbps: 2500,
	})

	publisher := newTestPeer(t, hub, engine, "alice")
	audioTrack, videoTrack := publisherOffer(t, publisher)

	// Media must flow before the viewer subscribes: the hub only learns
	// about tracks when their first packets arrive.
	go pumpMedia(audioTrack)
	go pumpMedia(videoTrack)

	viewer := newTestPeer(t, hub, engine, "bob")

	video, audio := viewerSubscribe(t, viewer, engine)
	for _, track := range []*webrtc.TrackRemote{video, audio} {
		err = track.SetReadDeadline(time.Now().Add(readTimeout))
		if err != nil {
			t.Fatalf("read deadline: %v", err)
		}

		_, _, err = track.ReadRTP()
		if err != nil {
			t.Fatalf("no RTP on %s track: %v", track.Kind(), err)
		}
	}
}
