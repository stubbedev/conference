package sfu_test

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/stubbe/conference/internal/relay"
	"github.com/stubbe/conference/internal/sfu"
)

const (
	testSlug      = "integration-room"
	testTimeout   = 15 * time.Second
	readTimeout   = 10 * time.Second
	frameInterval = 33 * time.Millisecond
	frameBytes    = 1200
	testHost      = "127.0.0.1"
	testRoomName  = "Integration"
	msgRecording  = "recording"
	msgOffer      = "offer"
	testTURNPort  = 3478
)

// errNoTestConn reports a description for a connection the test never opened.
var errNoTestConn = errors.New("test peer: set remote description: no connection")

func newTestHub(t *testing.T, engine *sfu.Engine) *sfu.Hub {
	t.Helper()

	creds, err := relay.NewCredentials(relay.Config{Port: testTURNPort, TLSHost: ""})
	if err != nil {
		t.Fatal(err)
	}

	return sfu.NewHub(sfu.HubConfig{
		Engine: engine, Relay: creds, MaxMembers: 8, Speech: nil, Translate: false,
	})
}

// testPeer wires the test-side peer connections of one hub member. The
// pump goroutine applies the server's ICE candidates to the local peer
// connection they name (buffering them until its remote description
// exists) and forwards every other message to out for the test to inspect.
type testPeer struct {
	member *sfu.Member
	engine *sfu.Engine
	raw    chan sfu.Message
	out    chan sfu.Message
	mu     sync.Mutex
	conns  map[string]*testConn
}

// testConn is one local peer connection and the server candidates that
// arrived before its remote description.
type testConn struct {
	pc      *webrtc.PeerConnection
	pending []webrtc.ICECandidateInit
}

func newTestPeer(t *testing.T, hub *sfu.Hub, engine *sfu.Engine, name string, priv bool) *testPeer {
	t.Helper()

	return joinTestPeer(t, hub, engine, sfu.JoinRequest{
		Slug:       testSlug,
		RoomName:   testRoomName,
		MemberName: name,
		MaxMembers: 8,
		Priv:       priv,
		Host:       testHost,
		Resume:     "",
	})
}

func joinTestPeer(t *testing.T, hub *sfu.Hub, engine *sfu.Engine, req sfu.JoinRequest) *testPeer {
	t.Helper()

	peer := &testPeer{
		member: nil,
		engine: engine,
		raw:    make(chan sfu.Message, 256),
		out:    make(chan sfu.Message, 64),
		mu:     sync.Mutex{},
		conns:  map[string]*testConn{},
	}

	var err error

	peer.member, err = hub.JoinRoom(req, func(msg sfu.Message) { peer.raw <- msg })
	if err != nil {
		t.Fatalf("%s join: %v", req.MemberName, err)
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
	if msg.Candidate == nil {
		return
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	conn := p.conns[msg.PC]
	if conn == nil {
		return
	}

	if conn.pc.RemoteDescription() == nil {
		conn.pending = append(conn.pending, *msg.Candidate)

		return
	}

	_ = conn.pc.AddICECandidate(*msg.Candidate)
}

// setLocal installs the peer connection the server names pcID; the pump
// goroutine's ICE handling reads it under the same mutex, so writes and
// reads share one synchronized pattern.
func (p *testPeer) setLocal(pcID string, pc *webrtc.PeerConnection) {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.conns[pcID] = &testConn{pc: pc, pending: nil}
}

// localPC returns the peer connection the server names pcID, nil before
// it exists.
func (p *testPeer) localPC(pcID string) *webrtc.PeerConnection {
	p.mu.Lock()
	defer p.mu.Unlock()

	if conn := p.conns[pcID]; conn != nil {
		return conn.pc
	}

	return nil
}

func (p *testPeer) setRemote(pcID string, desc webrtc.SessionDescription) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	conn := p.conns[pcID]
	if conn == nil {
		return fmt.Errorf("%w %q", errNoTestConn, pcID)
	}

	err := conn.pc.SetRemoteDescription(desc)
	if err != nil {
		return fmt.Errorf("test peer: set remote description on %q: %w", pcID, err)
	}

	for _, candidate := range conn.pending {
		_ = conn.pc.AddICECandidate(candidate)
	}

	conn.pending = nil

	return nil
}

// downID is the connection the server carries source's media to a viewer on.
func downID(source *testPeer) string {
	return "down-" + source.member.ID
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

// drain returns everything queued right now, without waiting: it backs
// assertions that a message did NOT arrive.
func (p *testPeer) drain() []sfu.Message {
	var msgs []sfu.Message

	for {
		select {
		case msg := <-p.out:
			msgs = append(msgs, msg)
		default:
			return msgs
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

// newSampleTrack creates a dummy sample track of the given kind.
func newSampleTrack(t *testing.T, mimeType, id string) *webrtc.TrackLocalStaticSample {
	t.Helper()

	track, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: mimeType}, id, "publisher")
	if err != nil {
		t.Fatalf("%s track: %v", id, err)
	}

	return track
}

func addPublisherTracks(
	t *testing.T,
	peerConn *webrtc.PeerConnection,
) (*webrtc.TrackLocalStaticSample, *webrtc.TrackLocalStaticSample) {
	t.Helper()

	audio := newSampleTrack(t, webrtc.MimeTypeOpus, "audio")
	video := newSampleTrack(t, webrtc.MimeTypeVP8, "video")

	for _, track := range []webrtc.TrackLocal{audio, video} {
		_, err := peerConn.AddTrack(track)
		if err != nil {
			t.Fatalf("add track: %v", err)
		}
	}

	return audio, video
}

// trackKind labels a published track the way the client does: what a
// share's connection carries is the screen and its sound.
func trackKind(which sfu.Upstream, codecType webrtc.RTPCodecType) sfu.Kind {
	audio := codecType == webrtc.RTPCodecTypeAudio

	switch {
	case which == sfu.UpstreamScreen && audio:
		return sfu.KindScreenAudio
	case which == sfu.UpstreamScreen:
		return sfu.KindScreen
	case audio:
		return sfu.KindAudio
	default:
		return sfu.KindCamera
	}
}

// negotiateUp offers the publisher's upstream connection which to the
// hub and applies its answer.
func negotiateUp(t *testing.T, publisher *testPeer, which sfu.Upstream, peerConn *webrtc.PeerConnection) {
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

		tracks = append(tracks, sfu.TrackInfo{Mid: transceiver.Mid(), Kind: trackKind(which, sent.Kind())})
	}

	publisher.member.Handle(sfu.Message{Type: msgOffer, PC: which.PCID(), SDP: offer.SDP, Tracks: tracks})

	answer := publisher.next(t, "answer")
	if answer.PC != which.PCID() {
		t.Fatalf("answer for %q, want %q", answer.PC, which.PCID())
	}

	err = publisher.setRemote(which.PCID(), webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer.SDP})
	if err != nil {
		t.Fatalf("publisher srd: %v", err)
	}
}

// publisherPC creates the publisher's camera-and-microphone connection.
func publisherPC(t *testing.T, publisher *testPeer) *webrtc.PeerConnection {
	t.Helper()

	peerConn, err := publisher.engine.NewUpstreamPeerConnection(sfu.UpstreamMedia)
	if err != nil {
		t.Fatalf("publisher pc: %v", err)
	}

	attachUp(publisher, sfu.UpstreamMedia, peerConn)

	return peerConn
}

// attachUp registers peerConn as the publisher's upstream which and
// trickles its candidates to the hub.
func attachUp(publisher *testPeer, which sfu.Upstream, peerConn *webrtc.PeerConnection) {
	publisher.setLocal(which.PCID(), peerConn)
	peerConn.OnICECandidate(onICECandidate(publisher.member, which.PCID()))
}

// mediaPC returns the publisher's camera-and-microphone connection.
func mediaPC(t *testing.T, publisher *testPeer) *webrtc.PeerConnection {
	t.Helper()

	peerConn := publisher.localPC(sfu.UpstreamMedia.PCID())
	if peerConn == nil {
		t.Fatal("publisher has no upstream connection")
	}

	return peerConn
}

// publisherOffer negotiates the publisher's upstream connection with
// one audio and one video track and returns both writers.
func publisherOffer(
	t *testing.T,
	publisher *testPeer,
) (*webrtc.TrackLocalStaticSample, *webrtc.TrackLocalStaticSample) {
	t.Helper()

	peerConn := publisherPC(t, publisher)
	audio, video := addPublisherTracks(t, peerConn)
	negotiateUp(t, publisher, sfu.UpstreamMedia, peerConn)

	return audio, video
}

// publishAudioOnly negotiates the upstream with a single audio track.
func publishAudioOnly(t *testing.T, publisher *testPeer) *webrtc.TrackLocalStaticSample {
	t.Helper()

	peerConn := publisherPC(t, publisher)
	audio := newSampleTrack(t, webrtc.MimeTypeOpus, "audio")

	_, err := peerConn.AddTrack(audio)
	if err != nil {
		t.Fatalf("add audio track: %v", err)
	}

	negotiateUp(t, publisher, sfu.UpstreamMedia, peerConn)

	return audio
}

// addAudioTrack publishes a second Opus track on a live upstream, the
// way a translated voice joins the call.
func addAudioTrack(t *testing.T, publisher *testPeer) *webrtc.TrackLocalStaticSample {
	t.Helper()

	peerConn := mediaPC(t, publisher)
	audio := newSampleTrack(t, webrtc.MimeTypeOpus, "late-audio")

	_, err := peerConn.AddTrack(audio)
	if err != nil {
		t.Fatalf("add audio track: %v", err)
	}

	negotiateUp(t, publisher, sfu.UpstreamMedia, peerConn)

	return audio
}

// addVideoTrack renegotiates the publisher's upstream with a video track.
func addVideoTrack(t *testing.T, publisher *testPeer) *webrtc.TrackLocalStaticSample {
	t.Helper()

	peerConn := mediaPC(t, publisher)
	video := newSampleTrack(t, webrtc.MimeTypeVP8, "video")

	_, err := peerConn.AddTrack(video)
	if err != nil {
		t.Fatalf("add video track: %v", err)
	}

	negotiateUp(t, publisher, sfu.UpstreamMedia, peerConn)

	return video
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

	err := viewer.setRemote(offer.PC, webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP})
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

	subscribed, err := engine.NewDownstreamPeerConnection()
	if err != nil {
		t.Fatalf("viewer pc: %v", err)
	}

	viewer.setLocal(offer.PC, subscribed)
	subscribed.OnICECandidate(onICECandidate(viewer.member, offer.PC))
	subscribed.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		kinds <- track
	})

	return subscribed
}

func isDownOffer(offer sfu.Message) bool {
	return offer.Type == msgOffer && strings.HasPrefix(offer.PC, "down-")
}

// subscribeLoop answers every downstream offer on one peer connection
// (the hub renegotiates as the publisher's tracks register one by one)
// until done reports the wanted tracks have arrived. The kinds channel
// and peer connection carry across calls so a later phase keeps the
// same OnTrack handler and connection.
func subscribeLoop(
	t *testing.T,
	viewer *testPeer,
	engine *sfu.Engine,
	peerConn *webrtc.PeerConnection,
	kinds chan *webrtc.TrackRemote,
	done func(video, audio *webrtc.TrackRemote) bool,
	stage string,
) (*webrtc.TrackRemote, *webrtc.TrackRemote, *webrtc.PeerConnection) {
	t.Helper()

	var videoTrack, audioTrack *webrtc.TrackRemote

	deadline := time.After(testTimeout)

	for !done(videoTrack, audioTrack) {
		select {
		case offer := <-viewer.out:
			if !isDownOffer(offer) {
				continue
			}

			peerConn = viewerPC(t, viewer, engine, peerConn, offer, kinds)

			onDownOffer(t, viewer, peerConn, offer)
		case track := <-kinds:
			if track.Kind() == webrtc.RTPCodecTypeVideo {
				videoTrack = track
			}

			if track.Kind() == webrtc.RTPCodecTypeAudio {
				audioTrack = track
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %s", stage)
		}
	}

	return videoTrack, audioTrack, peerConn
}

// viewerSubscribe subscribes until both a video and an audio track
// have arrived.
func viewerSubscribe(
	t *testing.T,
	viewer *testPeer,
	engine *sfu.Engine,
) (*webrtc.TrackRemote, *webrtc.TrackRemote) {
	t.Helper()

	kinds := make(chan *webrtc.TrackRemote, 4)

	video, audio, _ := subscribeLoop(t, viewer, engine, nil, kinds,
		func(gotVideo, gotAudio *webrtc.TrackRemote) bool {
			return gotVideo != nil && gotAudio != nil
		},
		"audio and video tracks",
	)

	return video, audio
}

// TestMediaLoopback pushes real RTP from a publisher through the hub
// and asserts that a viewer who joined before the media started both
// negotiates and receives packets.
func TestMediaLoopback(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := newTestHub(t, engine)

	publisher := newTestPeer(t, hub, engine, "alice", false)
	audioTrack, videoTrack := publisherOffer(t, publisher)

	// Media must flow before the viewer subscribes: the hub only learns
	// about tracks when their first packets arrive.
	go pumpMedia(audioTrack)
	go pumpMedia(videoTrack)

	viewer := newTestPeer(t, hub, engine, "bob", false)

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

// TestLateAudioTrack checks that an audio track added after the first
// negotiation reaches viewers as audio even when a renegotiation
// registers it from the SDP before its first packet, codec still unknown.
func TestLateAudioTrack(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := newTestHub(t, engine)

	publisher := newTestPeer(t, hub, engine, "alice", false)
	audioTrack := publishAudioOnly(t, publisher)

	go pumpMedia(audioTrack)

	viewer := newTestPeer(t, hub, engine, "bob", false)

	kinds := make(chan *webrtc.TrackRemote, 4)

	_, _, peerConn := subscribeLoop(t, viewer, engine, nil, kinds,
		func(_, gotAudio *webrtc.TrackRemote) bool {
			return gotAudio != nil
		},
		"audio track",
	)

	lateTrack := addAudioTrack(t, publisher)

	// A second negotiation before the track's first packet, as when the
	// next translation track is added, registers it from the SDP.
	negotiateUp(t, publisher, sfu.UpstreamMedia, mediaPC(t, publisher))

	go pumpMedia(lateTrack)

	_, late, _ := subscribeLoop(t, viewer, engine, peerConn, kinds,
		func(_, gotAudio *webrtc.TrackRemote) bool {
			return gotAudio != nil
		},
		"late audio track",
	)

	err = late.SetReadDeadline(time.Now().Add(readTimeout))
	if err != nil {
		t.Fatalf("read deadline: %v", err)
	}

	_, _, err = late.ReadRTP()
	if err != nil {
		t.Fatalf("no RTP on late audio track: %v", err)
	}
}

// TestLateVideoTrack publishes audio first and adds video through an
// upstream renegotiation afterwards — the same shape as tracks
// registering one by one on slow machines. The later downstream offer
// must still reach the viewer; CI failed exactly here while the suite
// stayed green on fast machines.
func TestLateVideoTrack(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := newTestHub(t, engine)

	publisher := newTestPeer(t, hub, engine, "alice", false)
	audioTrack := publishAudioOnly(t, publisher)

	go pumpMedia(audioTrack)

	viewer := newTestPeer(t, hub, engine, "bob", false)

	kinds := make(chan *webrtc.TrackRemote, 4)

	_, _, peerConn := subscribeLoop(t, viewer, engine, nil, kinds,
		func(_, wantAudio *webrtc.TrackRemote) bool {
			return wantAudio != nil
		},
		"audio track",
	)

	videoTrack := addVideoTrack(t, publisher)

	go pumpMedia(videoTrack)

	video, _, _ := subscribeLoop(t, viewer, engine, peerConn, kinds,
		func(wantVideo, _ *webrtc.TrackRemote) bool {
			return wantVideo != nil
		},
		"late video track",
	)

	err = video.SetReadDeadline(time.Now().Add(readTimeout))
	if err != nil {
		t.Fatalf("read deadline: %v", err)
	}

	_, _, err = video.ReadRTP()
	if err != nil {
		t.Fatalf("no RTP on late video track: %v", err)
	}
}

func TestModerationSetsLanguage(t *testing.T) {
	t.Parallel()

	const (
		moderate = "moderate"
		sealedDE = "sealed-de"
	)

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := newTestHub(t, engine)

	host := newTestPeer(t, hub, engine, "host", true)
	guest := newTestPeer(t, hub, engine, "guest", false)

	guest.member.Handle(sfu.Message{Type: moderate, Target: host.member.ID, Action: sfu.ActionLang, IV: "iv", CT: sealedDE})

	if msg := guest.next(t, "error"); msg.Code != codeNotAllowed {
		t.Fatalf("a guest must not set languages, got %q", msg.Code)
	}

	// A host sets the guest's language, sealed; only the guest gets it.
	host.member.Handle(sfu.Message{Type: moderate, Target: guest.member.ID, Action: sfu.ActionLang, IV: "iv", CT: sealedDE})

	if msg := guest.next(t, "forced"); msg.Action != sfu.ActionLang || msg.CT != sealedDE || msg.From != host.member.ID {
		t.Fatalf("guest expected a sealed language from the host, got %+v", msg)
	}

	host.member.Handle(sfu.Message{Type: moderate, Target: guest.member.ID, Action: sfu.ActionLang})

	if msg := host.next(t, "error"); msg.Code != "bad-lang" {
		t.Fatalf("an unsealed language must be refused, got %q", msg.Code)
	}
}

func TestModeration(t *testing.T) {
	t.Parallel()

	const moderate = "moderate"

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := newTestHub(t, engine)

	host := newTestPeer(t, hub, engine, "host", true)
	guest := newTestPeer(t, hub, engine, "guest", false)

	// Unprivileged members cannot moderate.
	guest.member.Handle(sfu.Message{Type: moderate, Target: host.member.ID, Action: sfu.ActionMute})

	if msg := guest.next(t, "error"); msg.Code != "not-allowed" {
		t.Fatalf("guest expected not-allowed, got %q", msg.Code)
	}

	// Media actions reach the target as a forced event.
	host.member.Handle(sfu.Message{Type: moderate, Target: guest.member.ID, Action: sfu.ActionMute})

	if msg := guest.next(t, "forced"); msg.Action != sfu.ActionMute {
		t.Fatalf("guest expected forced mute, got %q", msg.Action)
	}

	// Unknown actions are rejected.
	host.member.Handle(sfu.Message{Type: moderate, Target: guest.member.ID, Action: "nope"})

	if msg := host.next(t, "error"); msg.Code != "bad-action" {
		t.Fatalf("host expected bad-action, got %q", msg.Code)
	}

	// Kick removes the target and notifies the rest of the room.
	host.member.Handle(sfu.Message{Type: moderate, Target: guest.member.ID, Action: sfu.ActionKick})

	if msg := guest.next(t, "kicked"); msg.Type != "kicked" {
		t.Fatalf("guest expected kicked, got %q", msg.Type)
	}

	if msg := host.next(t, "member-left"); msg.ID != guest.member.ID {
		t.Fatalf("host expected member-left for guest, got %q", msg.ID)
	}

	if live := hub.LiveCount(testSlug); live != 1 {
		t.Fatalf("expected 1 member left, got %d", live)
	}
}

// expectRecording asserts the next recording event on a peer.
func expectRecording(t *testing.T, peer *testPeer, fromID string, announced bool) {
	t.Helper()

	msg := peer.next(t, msgRecording)

	if msg.From != fromID || msg.On != announced {
		t.Fatalf("%s expected recording on=%v from %q, got on=%v from %q", peer.member.Name, announced, fromID, msg.On, msg.From)
	}
}

func TestRecordingAnnouncement(t *testing.T) {
	t.Parallel()

	const record = "record"

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := newTestHub(t, engine)

	host := newTestPeer(t, hub, engine, "host", true)
	guest := newTestPeer(t, hub, engine, "guest", false)

	// Any member may record, not only a privileged one. The announcement
	// reaches everyone, the recorder included, so its own badge comes
	// from the room rather than local state.
	guest.member.Handle(sfu.Message{Type: record, On: true})
	expectRecording(t, guest, guest.member.ID, true)
	expectRecording(t, host, guest.member.ID, true)

	// A second recorder is rejected while one is announced, a host too.
	host.member.Handle(sfu.Message{Type: record, On: true})

	if msg := host.next(t, "error"); msg.Code != "record-busy" {
		t.Fatalf("host expected record-busy, got %q", msg.Code)
	}

	// Late joiners get the flag replayed in the welcome.
	late := newTestPeer(t, hub, engine, "late", false)

	if msg := late.next(t, "welcome"); msg.Recorder != guest.member.ID {
		t.Fatalf("late joiner expected recorder %q, got %q", guest.member.ID, msg.Recorder)
	}
}

func TestRecordingLifecycle(t *testing.T) {
	t.Parallel()

	const record = "record"

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := newTestHub(t, engine)

	host := newTestPeer(t, hub, engine, "host", true)
	guest := newTestPeer(t, hub, engine, "guest", false)

	host.member.Handle(sfu.Message{Type: record, On: true})
	expectRecording(t, host, host.member.ID, true)
	expectRecording(t, guest, host.member.ID, true)

	// Re-announcing by the active recorder changes nothing: the room is
	// not flooded with duplicate recording events.
	host.member.Handle(sfu.Message{Type: record, On: true})
	time.Sleep(100 * time.Millisecond)

	for _, msg := range guest.drain() {
		if msg.Type == msgRecording {
			t.Fatalf("re-announce produced a duplicate recording event: %+v", msg)
		}
	}

	// Releasing by anyone but the recorder is a no-op.
	guest.member.Handle(sfu.Message{Type: record, On: false})
	time.Sleep(100 * time.Millisecond)

	for _, msg := range host.drain() {
		if msg.Type == msgRecording {
			t.Fatalf("release by a non-recorder produced a recording event: %+v", msg)
		}
	}

	// The recorder leaving clears the flag for everyone still present.
	host.member.Leave()
	expectRecording(t, guest, host.member.ID, false)

	// The room accepts a new recorder again.
	host2 := newTestPeer(t, hub, engine, "host2", true)
	host2.member.Handle(sfu.Message{Type: record, On: true})
	expectRecording(t, host2, host2.member.ID, true)
	expectRecording(t, guest, host2.member.ID, true)
}

// watchKeyframeOnPublisher closes keyframe once the publisher's video
// sender receives an RTCP PLI.
func watchKeyframeOnPublisher(sender *webrtc.RTPSender, keyframe chan struct{}) {
	go func() {
		for {
			packets, _, readErr := sender.ReadRTCP()
			if readErr != nil {
				return
			}

			for _, packet := range packets {
				if _, ok := packet.(*rtcp.PictureLossIndication); ok {
					close(keyframe)

					return
				}
			}
		}
	}()
}

// TestKeyframeRequestForwarding asserts that a viewer's RTCP PLI — what a
// browser sends after losing video packets mid-call — is relayed to the
// publisher as a keyframe request. Without the relay the first lost packet
// leaves the viewer's video frozen on its last decodable frame.
func TestKeyframeRequestForwarding(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := newTestHub(t, engine)

	publisher := newTestPeer(t, hub, engine, "alice", false)
	audioTrack, videoTrack := publisherOffer(t, publisher)

	go pumpMedia(audioTrack)
	go pumpMedia(videoTrack)

	viewer := newTestPeer(t, hub, engine, "bob", false)
	video, _ := viewerSubscribe(t, viewer, engine)

	// Let the subscribe-time keyframe requests drain before listening, so
	// the assertion below can only be satisfied by the relayed viewer PLI.
	time.Sleep(time.Second)

	keyframe := make(chan struct{})

	for _, transceiver := range mediaPC(t, publisher).GetTransceivers() {
		sender := transceiver.Sender()
		if sender == nil || sender.Track() == nil || sender.Track().Kind() != webrtc.RTPCodecTypeVideo {
			continue
		}

		watchKeyframeOnPublisher(sender, keyframe)
	}

	err = viewer.localPC(downID(publisher)).WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(video.SSRC())}})
	if err != nil {
		t.Fatalf("viewer pli: %v", err)
	}

	select {
	case <-keyframe:
	case <-time.After(testTimeout):
		t.Fatal("publisher never received the viewer's keyframe request")
	}
}

// watchRembOnPublisher streams the bitrate of every REMB the publisher's
// video sender receives, until the peer connection closes.
func watchRembOnPublisher(sender *webrtc.RTPSender) <-chan float64 {
	rembs := make(chan float64, 8)

	go func() {
		defer close(rembs)

		for {
			packets, _, readErr := sender.ReadRTCP()
			if readErr != nil {
				return
			}

			for _, packet := range packets {
				remb, ok := packet.(*rtcp.ReceiverEstimatedMaximumBitrate)
				if !ok {
					continue
				}

				rembs <- float64(remb.Bitrate)
			}
		}
	}()

	return rembs
}

// publisherVideoSender returns the publisher's video sender, the one the
// hub throttles with REMB.
func publisherVideoSender(t *testing.T, publisher *testPeer) *webrtc.RTPSender {
	t.Helper()

	for _, transceiver := range mediaPC(t, publisher).GetTransceivers() {
		sender := transceiver.Sender()
		if sender != nil && sender.Track() != nil && sender.Track().Kind() == webrtc.RTPCodecTypeVideo {
			return sender
		}
	}

	t.Fatal("publisher has no video sender")

	return nil
}

// waitRemb waits for a REMB that accept takes, failing after the test
// timeout.
func waitRemb(t *testing.T, rembs <-chan float64, what string, accept func(float64) bool) float64 {
	t.Helper()

	deadline := time.After(testTimeout)

	for {
		select {
		case bitrate, open := <-rembs:
			if !open {
				t.Fatalf("publisher's RTCP reader closed while waiting for %s", what)
			}

			if accept(bitrate) {
				return bitrate
			}
		case <-deadline:
			t.Fatalf("publisher never received %s", what)
		}
	}
}

// TestViewerRembCapsPublisher asserts that a viewer's REMB drives the REMB
// the hub feeds the publisher: a constrained downlink must throttle the
// publisher instead of flooding it into a frozen picture (Galène-style
// adaptive forwarding).
func TestViewerRembCapsPublisher(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := newTestHub(t, engine)

	publisher := newTestPeer(t, hub, engine, "alice", false)
	audioTrack, videoTrack := publisherOffer(t, publisher)

	go pumpMedia(audioTrack)
	go pumpMedia(videoTrack)

	viewer := newTestPeer(t, hub, engine, "bob", false)
	video, _ := viewerSubscribe(t, viewer, engine)

	const rembCap = 200_000.0

	rembs := watchRembOnPublisher(publisherVideoSender(t, publisher))

	err = viewer.localPC(downID(publisher)).WriteRTCP([]rtcp.Packet{
		&rtcp.ReceiverEstimatedMaximumBitrate{
			SenderSSRC: 1,
			Bitrate:    rembCap,
			SSRCs:      []uint32{uint32(video.SSRC())},
		},
	})
	if err != nil {
		t.Fatalf("viewer remb: %v", err)
	}

	waitRemb(t, rembs, "a viewer-capped REMB", func(bitrate float64) bool { return bitrate <= rembCap*1.01 })
}

// TestSingleLayerVideoIsLimitedOnlyOnceLossShows asserts that a
// single-layer video stream, which has no simulcast layer to step down to,
// is not held to any guess while its viewer's link is clean: on the
// camera's connection the browser's own delay-based estimate measures the
// uplink, and the hub only speaks up once the viewer loses packets.
func TestSingleLayerVideoIsLimitedOnlyOnceLossShows(t *testing.T) {
	t.Parallel()

	call := newSingleLayerCall(t)

	noRemb(t, call.rembs, "a REMB before the viewer reported any loss", 3*rembPeriod)

	call.report(t, 64)

	waitRemb(t, call.rembs, "a REMB below the stream's rate after heavy loss", belowDelivered)
}

// TestSingleLayerVideoRembRecoversAfterCongestion asserts the other half of
// the controller: once the viewer reports a clean link and says its own
// downlink is healthy again, the publisher gets that room back on that
// report. A stream that only adapts downwards stays degraded by one bad
// minute for the rest of the call.
func TestSingleLayerVideoRembRecoversAfterCongestion(t *testing.T) {
	t.Parallel()

	call := newSingleLayerCall(t)

	noRemb(t, call.rembs, "a REMB before the viewer reported any loss", 2*rembPeriod)

	call.report(t, 64)

	waitRemb(t, call.rembs, "a REMB below the stream's rate after heavy loss", belowDelivered)

	call.report(t, 0)
	call.setREMB(t, recoveredDownlink)

	waitRemb(t, call.rembs, "the viewer's own estimate back once its link recovered", func(bitrate float64) bool {
		return bitrate >= recoveredDownlink*0.99
	})
}

// noRemb asserts the publisher receives no REMB for a while.
func noRemb(t *testing.T, rembs <-chan float64, what string, wait time.Duration) {
	t.Helper()

	select {
	case bitrate := <-rembs:
		t.Fatalf("publisher received %s: %.0f bps", what, bitrate)
	case <-time.After(wait):
	}
}

// singleLayerCall is one member publishing single-layer video to one
// viewer, with the publisher's RTCP watched for the bitrate the hub feeds
// it. Without simulcast layers to move between, it is the only kind of
// video stream the hub throttles with REMB.
type singleLayerCall struct {
	viewer *testPeer
	down   string
	ssrc   uint32
	rembs  <-chan float64
}

const (
	// rembPeriod is how often the hub feeds publishers their REMB.
	rembPeriod = time.Second

	// deliveredRate is what pumpMedia publishes, in bits per second.
	deliveredRate = frameBytes * 8 * float64(time.Second) / float64(frameInterval)

	// recoveredDownlink is a viewer's own estimate of a healthy downlink.
	recoveredDownlink = 2_500_000.0
)

func newSingleLayerCall(t *testing.T) singleLayerCall {
	t.Helper()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	t.Cleanup(closeEngine)

	hub := newTestHub(t, engine)

	publisher := newTestPeer(t, hub, engine, "alice", false)
	audio, video := publisherOffer(t, publisher)

	go pumpMedia(audio)
	go pumpMedia(video)

	viewer := newTestPeer(t, hub, engine, "bob", false)
	remote, _ := viewerSubscribe(t, viewer, engine)

	return singleLayerCall{
		viewer: viewer,
		down:   downID(publisher),
		ssrc:   uint32(remote.SSRC()),
		rembs:  watchRembOnPublisher(publisherVideoSender(t, publisher)),
	}
}

// report sends one receiver report, the viewer's account of what it lost.
func (c singleLayerCall) report(t *testing.T, fractionLost uint8) {
	t.Helper()

	packet := &rtcp.ReceiverReport{
		SSRC:    1,
		Reports: []rtcp.ReceptionReport{{SSRC: c.ssrc, FractionLost: fractionLost}},
	}

	err := c.viewer.localPC(c.down).WriteRTCP([]rtcp.Packet{packet})
	if err != nil {
		t.Fatalf("viewer receiver report: %v", err)
	}
}

// setREMB sends the viewer's own estimate of its downlink.
func (c singleLayerCall) setREMB(t *testing.T, bitrate float64) {
	t.Helper()

	packet := &rtcp.ReceiverEstimatedMaximumBitrate{
		SenderSSRC: 1,
		Bitrate:    float32(bitrate),
		SSRCs:      []uint32{c.ssrc},
	}

	err := c.viewer.localPC(c.down).WriteRTCP([]rtcp.Packet{packet})
	if err != nil {
		t.Fatalf("viewer remb: %v", err)
	}
}

func belowDelivered(bitrate float64) bool { return bitrate < deliveredRate }

// TestWelcomeCarriesRelayCredentials checks that a member is handed
// TURN credentials for the host it signaled on, and that the hub
// vouches for them exactly while the member is in the call.
func TestWelcomeCarriesRelayCredentials(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := newTestHub(t, engine)
	peer := newTestPeer(t, hub, engine, "alice", false)

	welcome := peer.next(t, "welcome")
	if len(welcome.ICEServers) != 1 {
		t.Fatalf("welcome ICE servers: %+v", welcome.ICEServers)
	}

	server := welcome.ICEServers[0]
	if server.Username != peer.member.ID || server.Credential == "" {
		t.Fatalf("credentials %q/%q for member %s", server.Username, server.Credential, peer.member.ID)
	}

	want := "turn:127.0.0.1:3478?transport=udp"
	if len(server.URLs) == 0 || server.URLs[0] != want {
		t.Fatalf("URLs %v, want %s first", server.URLs, want)
	}

	if !hub.MemberLive(peer.member.ID) {
		t.Fatal("joined member is not live")
	}

	peer.member.Leave()

	deadline := time.Now().Add(testTimeout)
	for hub.MemberLive(peer.member.ID) {
		if time.Now().After(deadline) {
			t.Fatal("member still live after leaving")
		}

		time.Sleep(10 * time.Millisecond)
	}
}

// TestLeaveAlwaysTearsDown repeats join/leave so that a leave which
// only sometimes removes the member (a ghost left in the room, never
// announced) fails reliably.
func TestLeaveAlwaysTearsDown(t *testing.T) {
	t.Parallel()

	const rounds = 50

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := newTestHub(t, engine)
	stayer := newTestPeer(t, hub, engine, "stayer", false)

	for round := range rounds {
		leaver := newTestPeer(t, hub, engine, fmt.Sprintf("leaver-%d", round), false)
		leaver.member.Leave()

		left := stayer.next(t, "member-left")
		if left.ID != leaver.member.ID {
			t.Fatalf("round %d: member-left for %s, want %s", round, left.ID, leaver.member.ID)
		}

		if live := hub.LiveCount(testSlug); live != 1 {
			t.Fatalf("round %d: %d live members after a leave, want 1", round, live)
		}
	}
}

// TestRecordingSurvivesOtherLeaves checks that only the recorder's own
// departure clears the room's recording state: late joiners must still
// be told about a recording after any other member left.
func TestRecordingSurvivesOtherLeaves(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := newTestHub(t, engine)

	host := newTestPeer(t, hub, engine, "host", true)
	guest := newTestPeer(t, hub, engine, "guest", false)

	host.member.Handle(sfu.Message{Type: "record", On: true})
	expectRecording(t, host, host.member.ID, true)

	guest.member.Leave()

	if left := host.next(t, "member-left"); left.ID != guest.member.ID {
		t.Fatalf("member-left for %s, want %s", left.ID, guest.member.ID)
	}

	late := newTestPeer(t, hub, engine, "late", false)
	if welcome := late.next(t, "welcome"); welcome.Recorder != host.member.ID {
		t.Fatalf("late joiner told recorder %q, want %s", welcome.Recorder, host.member.ID)
	}
}

// TestResumeReplacesStaleMember rejoins with the token from the first
// welcome, as a client does after its connection dropped: the stale
// member is replaced in place (the room never counts both, the others
// learn which member was replaced) and an active recording carries
// over instead of being cleared.
func TestResumeReplacesStaleMember(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := newTestHub(t, engine)

	host := newTestPeer(t, hub, engine, "host", true)
	guest := newTestPeer(t, hub, engine, "guest", false)

	token := host.next(t, "welcome").Resume
	if token == "" {
		t.Fatal("welcome carried no resume token")
	}

	host.member.Handle(sfu.Message{Type: "record", On: true})
	expectRecording(t, guest, host.member.ID, true)

	rejoined := joinTestPeer(t, hub, engine, sfu.JoinRequest{
		Slug: testSlug, RoomName: testRoomName, MemberName: "host",
		MaxMembers: 8, Priv: true, Host: testHost, Resume: token,
	})

	if live := hub.LiveCount(testSlug); live != 2 {
		t.Fatalf("%d live members right after the rejoin, want 2", live)
	}

	expectReplaced(t, guest, rejoined, host.member.ID)
	expectResumedWelcome(t, rejoined, token)

	if hub.MemberLive(host.member.ID) {
		t.Fatal("the stale member is still live")
	}
}

// TestResumeIgnoresUnknownTokens checks that a join with a token no
// member holds is an ordinary join and replaces nobody.
func TestResumeIgnoresUnknownTokens(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := newTestHub(t, engine)

	first := newTestPeer(t, hub, engine, "first", false)

	joinTestPeer(t, hub, engine, sfu.JoinRequest{
		Slug: testSlug, RoomName: testRoomName, MemberName: "second",
		MaxMembers: 8, Priv: false, Host: testHost, Resume: "not-a-token",
	})

	if joined := first.next(t, "member-joined"); joined.Replaces != "" {
		t.Fatalf("an unknown token replaced %s", joined.Replaces)
	}

	if live := hub.LiveCount(testSlug); live != 2 {
		t.Fatalf("%d live members, want 2", live)
	}
}

// expectReplaced asserts that viewer saw rejoined replace staleID: one
// member-joined naming the stale member, then its member-left, and no
// change to the recording state in between.
func expectReplaced(t *testing.T, viewer, rejoined *testPeer, staleID string) {
	t.Helper()

	joined := viewer.next(t, "member-joined")
	if joined.ID != rejoined.member.ID || joined.Replaces != staleID {
		t.Fatalf("member-joined %s replacing %q, want %s replacing %s", joined.ID, joined.Replaces, rejoined.member.ID, staleID)
	}

	if left := viewer.next(t, "member-left"); left.ID != staleID {
		t.Fatalf("member-left for %s, want the stale %s", left.ID, staleID)
	}

	for _, msg := range viewer.drain() {
		if msg.Type == msgRecording {
			t.Fatalf("the rejoin changed the recording state: %+v", msg)
		}
	}
}

// expectResumedWelcome asserts the rejoined member took over the
// recording and got a fresh resume token.
func expectResumedWelcome(t *testing.T, rejoined *testPeer, oldToken string) {
	t.Helper()

	welcome := rejoined.next(t, "welcome")
	if welcome.Recorder != rejoined.member.ID {
		t.Fatalf("rejoined welcome names recorder %q, want %s", welcome.Recorder, rejoined.member.ID)
	}

	if welcome.Resume == "" || welcome.Resume == oldToken {
		t.Fatalf("rejoined welcome resume token %q, want a fresh one", welcome.Resume)
	}
}
