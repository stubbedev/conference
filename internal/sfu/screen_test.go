package sfu_test

import (
	"bytes"
	"maps"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"github.com/stubbe/conference/internal/sfu"
)

// Track IDs of a member publishing its camera and a share at once; each
// track's packets carry its own marker byte.
const (
	micID         = "mic"
	cameraID      = "camera"
	screenID      = "screen"
	screenAudioID = "screen-audio"
)

// markerOf is the byte every packet of the track published under id is filled with.
func markerOf(id string) byte {
	switch id {
	case micID:
		return 0xa1
	case cameraID:
		return 0xc2
	case screenID:
		return 0x53
	case screenAudioID:
		return 0x5a
	default:
		panic("no marker for track " + id)
	}
}

// published is one track a test publisher sends and the sender it goes out on.
type published struct {
	track  *webrtc.TrackLocalStaticSample
	sender *webrtc.RTPSender
}

// shareCall is one member publishing its camera and microphone on one
// connection and a share with its sound on another, watched by a viewer.
type shareCall struct {
	engine    *sfu.Engine
	publisher *testPeer
	viewer    *testPeer
	sent      map[string]published
	received  map[string]*webrtc.TrackRemote
	tracks    chan *webrtc.TrackRemote
	viewerPC  *webrtc.PeerConnection
}

// publishOn opens the publisher's upstream which on a connection of api,
// with an audio and a video track. Every connection starts its mids at 0,
// so two of them collide.
func publishOn(t *testing.T, api *webrtc.API, publisher *testPeer, which sfu.Upstream, audioID, videoID string) map[string]published {
	t.Helper()

	peerConn, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("%s pc: %v", which, err)
	}

	t.Cleanup(func() { _ = peerConn.Close() })

	attachUp(publisher, which, peerConn)

	sent := map[string]published{}

	for _, each := range []struct{ id, mime string }{{audioID, webrtc.MimeTypeOpus}, {videoID, webrtc.MimeTypeVP8}} {
		track, trackErr := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: each.mime}, each.id, which.PCID())
		if trackErr != nil {
			t.Fatalf("%s track: %v", each.id, trackErr)
		}

		sender, addErr := peerConn.AddTrack(track)
		if addErr != nil {
			t.Fatalf("add %s: %v", each.id, addErr)
		}

		sent[each.id] = published{track: track, sender: sender}
	}

	negotiateUp(t, publisher, which, peerConn)

	return sent
}

// pumpMarked writes frames filled with marker until the track fails.
func pumpMarked(track *webrtc.TrackLocalStaticSample, marker byte) {
	ticker := time.NewTicker(frameInterval)
	defer ticker.Stop()

	sample := media.Sample{Data: bytes.Repeat([]byte{marker}, frameBytes), Duration: frameInterval}

	for range ticker.C {
		err := track.WriteSample(sample)
		if err != nil {
			return
		}
	}
}

func newShareCall(t *testing.T) *shareCall {
	t.Helper()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	t.Cleanup(closeEngine)

	hub := newTestHub(t, engine)
	publisher := newTestPeer(t, hub, engine, "alice", false)

	sent := publishOn(t, twccPublisherAPI(t), publisher, sfu.UpstreamMedia, micID, cameraID)
	maps.Copy(sent, publishOn(t, twccPublisherAPI(t), publisher, sfu.UpstreamScreen, screenAudioID, screenID))

	for id, each := range sent {
		go pumpMarked(each.track, markerOf(id))
	}

	call := &shareCall{
		engine: engine, publisher: publisher, viewer: newTestPeer(t, hub, engine, "bob", false),
		sent: sent, received: map[string]*webrtc.TrackRemote{}, tracks: make(chan *webrtc.TrackRemote, 8), viewerPC: nil,
	}

	call.answerUntil(t, "all four tracks", func(sfu.Message) bool { return len(call.received) == len(call.sent) })

	return call
}

// answerUntil answers the viewer's downstream offers and collects its
// tracks until done accepts the last offer answered.
func (c *shareCall) answerUntil(t *testing.T, stage string, done func(offer sfu.Message) bool) {
	t.Helper()

	deadline := time.After(testTimeout)

	var last sfu.Message

	for !done(last) {
		select {
		case offer := <-c.viewer.out:
			if !isDownOffer(offer) {
				continue
			}

			c.viewerPC = viewerPC(t, c.viewer, c.engine, c.viewerPC, offer, c.tracks)
			onDownOffer(t, c.viewer, c.viewerPC, offer)

			last = offer
		case track := <-c.tracks:
			c.received[track.ID()] = track
		case <-deadline:
			t.Fatalf("timed out waiting for %s", stage)
		}
	}
}

// expectMarked reads from a received track until a packet arrives and
// asserts it carries the marker of the track published under id.
func (c *shareCall) expectMarked(t *testing.T, id string) {
	t.Helper()

	track := c.received[id]
	if track == nil {
		t.Fatalf("the viewer never received %s", id)
	}

	err := track.SetReadDeadline(time.Now().Add(readTimeout))
	if err != nil {
		t.Fatalf("read deadline: %v", err)
	}

	packet, _, err := track.ReadRTP()
	if err != nil {
		t.Fatalf("no RTP on %s: %v", id, err)
	}

	if len(packet.Payload) == 0 {
		t.Fatalf("%s arrived with an empty payload", id)
	}

	if last := packet.Payload[len(packet.Payload)-1]; last != markerOf(id) {
		t.Fatalf("%s carries another track's packets: payload ends %x, want %x", id, last, markerOf(id))
	}
}

func offeredKinds(offer sfu.Message) []sfu.Kind {
	kinds := make([]sfu.Kind, 0, len(offer.Tracks))
	for _, info := range offer.Tracks {
		kinds = append(kinds, info.Kind)
	}

	slices.Sort(kinds)

	return kinds
}

// TestShareConnectionForwardsBesideTheCamera publishes a camera and a
// share on two connections whose mids collide and checks that every
// track reaches the viewer as itself.
func TestShareConnectionForwardsBesideTheCamera(t *testing.T) {
	t.Parallel()

	call := newShareCall(t)

	for id := range call.sent {
		call.expectMarked(t, id)
	}

	mids := map[sfu.Upstream][]string{}

	for _, each := range []struct {
		which sfu.Upstream
		ids   []string
	}{{sfu.UpstreamMedia, []string{micID, cameraID}}, {sfu.UpstreamScreen, []string{screenAudioID, screenID}}} {
		for _, id := range each.ids {
			for _, transceiver := range call.publisher.localPC(each.which.PCID()).GetTransceivers() {
				if transceiver.Sender() == call.sent[id].sender {
					mids[each.which] = append(mids[each.which], transceiver.Mid())
				}
			}
		}
	}

	slices.Sort(mids[sfu.UpstreamMedia])
	slices.Sort(mids[sfu.UpstreamScreen])

	if !slices.Equal(mids[sfu.UpstreamMedia], mids[sfu.UpstreamScreen]) {
		t.Fatalf("the connections' mids %v and %v do not collide; the test proves nothing", mids[sfu.UpstreamMedia], mids[sfu.UpstreamScreen])
	}
}

// TestShareConnectionLeavesOutTransportWideFeedback checks that the
// share's connection is answered without transport-wide congestion
// control, so the browser's estimate rests on the server's REMB, while
// the camera's connection keeps it.
func TestShareConnectionLeavesOutTransportWideFeedback(t *testing.T) {
	t.Parallel()

	call := newShareCall(t)

	media := call.publisher.localPC(sfu.UpstreamMedia.PCID()).RemoteDescription().SDP
	if !strings.Contains(media, transportCCURI) || !strings.Contains(media, webrtc.TypeRTCPFBTransportCC) {
		t.Fatal("the camera's connection was answered without transport-wide congestion control")
	}

	screen := call.publisher.localPC(sfu.UpstreamScreen.PCID()).RemoteDescription().SDP
	if strings.Contains(screen, transportCCURI) || strings.Contains(screen, webrtc.TypeRTCPFBTransportCC) {
		t.Fatal("the share's connection was answered with transport-wide congestion control")
	}

	if !strings.Contains(screen, "goog-remb") {
		t.Fatal("the share's connection was answered without REMB, so nothing would hold its estimate up")
	}
}

// TestShareConnectionKeepsItsOwnRemb checks that each connection gets
// its own REMB: a viewer whose downlink caps the camera does not drag
// the share down with it, and the share, losing nothing, is limited by
// nothing.
func TestShareConnectionKeepsItsOwnRemb(t *testing.T) {
	t.Parallel()

	call := newShareCall(t)

	cameraRembs := watchRembOnPublisher(call.sent[cameraID].sender)
	screenRembs := watchRembOnPublisher(call.sent[screenID].sender)

	const rembCap = 200_000.0

	err := call.viewerPC.WriteRTCP([]rtcp.Packet{&rtcp.ReceiverEstimatedMaximumBitrate{
		SenderSSRC: 1, Bitrate: rembCap, SSRCs: []uint32{uint32(call.received[cameraID].SSRC())},
	}})
	if err != nil {
		t.Fatalf("viewer remb: %v", err)
	}

	waitRemb(t, cameraRembs, "a viewer-capped REMB on the camera", func(bitrate float64) bool { return bitrate <= rembCap*1.01 })
	waitRemb(t, screenRembs, "an unlimited REMB on the share after the camera was capped", func(bitrate float64) bool {
		return bitrate >= sfu.BrowserMaxBitrate*0.99
	})
}

// firstRembDelay bounds how long after its first packet a share may wait
// for its first REMB: well inside the two seconds libwebrtc starts its
// estimate from one, and well short of the REMB ticker's period, so a
// REMB that waits for the next tick fails.
const firstRembDelay = 250 * time.Millisecond

// waitPublisherConnected waits until the publisher's connection can send
// media: its DTLS handshake, which the server finishes first, is done.
func waitPublisherConnected(t *testing.T, peerConn *webrtc.PeerConnection) {
	t.Helper()

	deadline := time.Now().Add(testTimeout)

	for peerConn.ConnectionState() != webrtc.PeerConnectionStateConnected {
		if time.Now().After(deadline) {
			t.Fatalf("the publisher's connection never connected: %s", peerConn.ConnectionState())
		}

		time.Sleep(10 * time.Millisecond)
	}
}

// TestShareGetsItsFirstRembWithItsFirstPacket starts a share on a still
// screen, one frame and nothing after, and checks that the REMB lifting
// its estimate arrives right after that frame instead of at the next tick.
func TestShareGetsItsFirstRembWithItsFirstPacket(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	t.Cleanup(closeEngine)

	publisher := newTestPeer(t, newTestHub(t, engine), engine, "alice", false)
	sent := publishOn(t, twccPublisherAPI(t), publisher, sfu.UpstreamScreen, screenAudioID, screenID)
	rembs := watchRembOnPublisher(sent[screenID].sender)

	waitPublisherConnected(t, publisher.localPC(sfu.UpstreamScreen.PCID()))

	frame := media.Sample{Data: bytes.Repeat([]byte{markerOf(screenID)}, frameBytes), Duration: frameInterval}
	start := time.Now()

	err = sent[screenID].track.WriteSample(frame)
	if err != nil {
		t.Fatalf("first frame: %v", err)
	}

	waitRemb(t, rembs, "an unlimited REMB on the share", func(bitrate float64) bool { return bitrate >= sfu.BrowserMaxBitrate*0.99 })

	if waited := time.Since(start); waited > firstRembDelay {
		t.Fatalf("the share's first REMB came %v after its first frame, want within %v", waited, firstRembDelay)
	}
}

// watchPLI counts the keyframe requests a publisher's sender receives.
func watchPLI(sender *webrtc.RTPSender) <-chan struct{} {
	plis := make(chan struct{}, 64)

	go func() {
		for {
			packets, _, err := sender.ReadRTCP()
			if err != nil {
				return
			}

			for _, packet := range packets {
				if _, ok := packet.(*rtcp.PictureLossIndication); ok {
					plis <- struct{}{}
				}
			}
		}
	}()

	return plis
}

// TestShareKeyframeRequestReachesOnlyTheShare checks that a viewer losing
// the share asks the share's connection for a keyframe, and leaves the
// camera's encoder alone.
func TestShareKeyframeRequestReachesOnlyTheShare(t *testing.T) {
	t.Parallel()

	call := newShareCall(t)

	cameraPLIs := watchPLI(call.sent[cameraID].sender)
	screenPLIs := watchPLI(call.sent[screenID].sender)

	time.Sleep(time.Second)

	for _, plis := range []<-chan struct{}{cameraPLIs, screenPLIs} {
		for len(plis) > 0 {
			<-plis
		}
	}

	err := call.viewerPC.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(call.received[screenID].SSRC())}})
	if err != nil {
		t.Fatalf("viewer pli: %v", err)
	}

	select {
	case <-screenPLIs:
	case <-time.After(testTimeout):
		t.Fatal("the share never received the viewer's keyframe request")
	}

	select {
	case <-cameraPLIs:
		t.Fatal("the viewer's keyframe request for the share reached the camera")
	case <-time.After(500 * time.Millisecond):
	}
}

// TestClosingShareConnectionKeepsTheCamera closes the share's connection
// and checks that the viewer loses the share and its sound, and nothing
// else.
func TestClosingShareConnectionKeepsTheCamera(t *testing.T) {
	t.Parallel()

	call := newShareCall(t)

	call.publisher.member.Handle(sfu.Message{Type: "close", PC: sfu.UpstreamScreen.PCID()})

	want := []sfu.Kind{sfu.KindAudio, sfu.KindCamera}

	call.answerUntil(t, "an offer without the share", func(offer sfu.Message) bool {
		return offer.SDP != "" && slices.Equal(offeredKinds(offer), want)
	})

	call.expectMarked(t, cameraID)
	call.expectMarked(t, micID)
}

// TestOfferMustNameItsConnection checks that an offer is refused before
// its SDP is read when it names no known upstream, or carries a track
// of no kind the client announces or one that belongs on the other one.
func TestOfferMustNameItsConnection(t *testing.T) {
	const unparsedSDP = "v=0"

	t.Parallel()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	publisher := newTestPeer(t, newTestHub(t, engine), engine, "alice", false)

	for _, offer := range []sfu.Message{
		{Type: msgOffer, PC: "", SDP: unparsedSDP},
		{Type: msgOffer, PC: "up-camera", SDP: unparsedSDP},
		{Type: msgOffer, PC: sfu.UpstreamMedia.PCID(), SDP: unparsedSDP, Tracks: []sfu.TrackInfo{{Mid: "0", Kind: sfu.KindScreen}}},
		{Type: msgOffer, PC: sfu.UpstreamScreen.PCID(), SDP: unparsedSDP, Tracks: []sfu.TrackInfo{{Mid: "0", Kind: sfu.KindCamera}}},
		{Type: msgOffer, PC: sfu.UpstreamMedia.PCID(), SDP: unparsedSDP, Tracks: []sfu.TrackInfo{{Mid: "0", Kind: "hologram"}}},
	} {
		publisher.member.Handle(offer)

		if msg := publisher.next(t, "error"); msg.Code != "bad-offer" {
			t.Fatalf("offer on %q with %+v answered %q, want bad-offer", offer.PC, offer.Tracks, msg.Code)
		}
	}
}
