package sfu_test

import (
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/stubbe/conference/internal/sfu"
)

const (
	audioLevelURI = "urn:ietf:params:rtp-hdrext:ssrc-audio-level"
	sdesMidURI    = "urn:ietf:params:rtp-hdrext:sdes:mid"

	// audioLevelByte is the one-byte ssrc-audio-level payload the test
	// publisher stamps on every packet (V=1, level 0).
	audioLevelByte = 0x80
	opusPacketMs   = 20
	opusFrameTicks = 960
	opusBytes      = 80
)

// browserLikeAPI builds a publisher whose extmap differs from the
// server's: browsers hand out extension IDs in their own order, so the
// ID a publisher uses for ssrc-audio-level routinely collides with the
// ID the server negotiates for sdes:mid on the viewer's connection.
func browserLikeAPI(t *testing.T) *webrtc.API {
	t.Helper()

	mediaEngine := &webrtc.MediaEngine{}

	err := mediaEngine.RegisterDefaultCodecs()
	if err != nil {
		t.Fatalf("register codecs: %v", err)
	}

	// Reverse of the server's registration order: audio-level gets the
	// ID the server uses for mid.
	for _, uri := range []string{audioLevelURI, sdesMidURI} {
		err = mediaEngine.RegisterHeaderExtension(
			webrtc.RTPHeaderExtensionCapability{URI: uri}, webrtc.RTPCodecTypeAudio)
		if err != nil {
			t.Fatalf("register extension %s: %v", uri, err)
		}
	}

	return webrtc.NewAPI(webrtc.WithMediaEngine(mediaEngine))
}

// negotiatedExtensionID returns the ID negotiated for uri, failing the
// test when the extension is absent.
func negotiatedExtensionID(t *testing.T, params webrtc.RTPParameters, uri, side string) uint8 {
	t.Helper()

	for _, ext := range params.HeaderExtensions {
		if ext.URI == uri {
			return uint8(ext.ID) //nolint:gosec // extmap IDs are 1..255 by construction
		}
	}

	t.Fatalf("%s did not negotiate %s", side, uri)

	return 0
}

// publishWithBrowserExtmap negotiates an audio-only upstream from a
// publisher using browserLikeAPI and returns the track plus the
// audio-level and mid extension IDs that publisher negotiated.
func publishWithBrowserExtmap(t *testing.T, publisher *testPeer) (*webrtc.TrackLocalStaticRTP, uint8, uint8) {
	t.Helper()

	publisherPC, err := browserLikeAPI(t).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatalf("publisher pc: %v", err)
	}

	publisher.setLocal(publisherPC)
	publisherPC.OnICECandidate(onICECandidate(publisher.member, "up"))

	audio, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		"audio", "publisher")
	if err != nil {
		t.Fatalf("audio track: %v", err)
	}

	sender, err := publisherPC.AddTrack(audio)
	if err != nil {
		t.Fatalf("add audio: %v", err)
	}

	negotiateUp(t, publisher, publisherPC)

	params := sender.GetParameters().RTPParameters

	return audio,
		negotiatedExtensionID(t, params, audioLevelURI, "publisher"),
		negotiatedExtensionID(t, params, sdesMidURI, "publisher")
}

// receiverParams returns the negotiated parameters of the receiver that
// owns track.
func receiverParams(t *testing.T, peerConn *webrtc.PeerConnection, track *webrtc.TrackRemote) webrtc.RTPParameters {
	t.Helper()

	for _, receiver := range peerConn.GetReceivers() {
		if receiver.Track() == track {
			return receiver.GetParameters()
		}
	}

	t.Fatal("no receiver owns the audio track")

	return webrtc.RTPParameters{}
}

// TestForwardRewritesHeaderExtensionIDs publishes Opus packets carrying
// an audio-level extension under the publisher's negotiated ID and
// asserts the viewer receives it under the viewer's own ID. Forwarded
// verbatim, the viewer would read the level byte as a MID and drop the
// packet: audio silently never arrived in browsers while video worked.
func TestForwardRewritesHeaderExtensionIDs(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewEngine(0, nil)
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := sfu.NewHub(sfu.HubConfig{Engine: engine, MaxMembers: 8, MaxPublishKbps: 2500})

	publisher := newTestPeer(t, hub, engine, "alice", false)
	audio, publisherLevelID, _ := publishWithBrowserExtmap(t, publisher)

	go pumpRTPWithExtension(audio, publisherLevelID)

	viewer := newTestPeer(t, hub, engine, "bob", false)
	kinds := make(chan *webrtc.TrackRemote, 4)

	_, audioRemote, viewerPC := subscribeLoop(t, viewer, engine, nil, kinds,
		func(_, gotAudio *webrtc.TrackRemote) bool { return gotAudio != nil },
		"audio track",
	)

	viewerLevelID := negotiatedExtensionID(t, receiverParams(t, viewerPC, audioRemote), audioLevelURI, "viewer")
	if viewerLevelID == publisherLevelID {
		t.Fatalf("test setup: both sides negotiated ID %d, the collision is not exercised", viewerLevelID)
	}

	err = audioRemote.SetReadDeadline(time.Now().Add(readTimeout))
	if err != nil {
		t.Fatalf("read deadline: %v", err)
	}

	packet, _, err := audioRemote.ReadRTP()
	if err != nil {
		t.Fatalf("no audio RTP at viewer: %v", err)
	}

	assertOnlyExtension(t, packet, viewerLevelID)
}

// TestForwardStripsMidExtension pins the fix for the one-way blackout:
// the sdes:mid value names an m-line of the publisher's connection, so
// forwarding it (re-numbered into the viewer's extmap) makes browsers
// demux bundled RTP by a mid from a different m-line numbering — audio
// packets land on the video receiver, decode as nothing, and the call
// stays silent until reload. The extension must be stripped; the viewer
// demuxes by the a=ssrc lines the downstream offer announces.
func TestForwardStripsMidExtension(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewEngine(0, nil)
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	hub := sfu.NewHub(sfu.HubConfig{Engine: engine, MaxMembers: 8, MaxPublishKbps: 2500})

	publisher := newTestPeer(t, hub, engine, "carol", false)
	audio, publisherLevelID, publisherMidID := publishWithBrowserExtmap(t, publisher)

	go pumpRTPWithMid(audio, publisherLevelID, publisherMidID)

	viewer := newTestPeer(t, hub, engine, "dave", false)
	kinds := make(chan *webrtc.TrackRemote, 4)

	_, audioRemote, viewerPC := subscribeLoop(t, viewer, engine, nil, kinds,
		func(_, gotAudio *webrtc.TrackRemote) bool { return gotAudio != nil },
		"audio track",
	)

	viewerLevelID := negotiatedExtensionID(t, receiverParams(t, viewerPC, audioRemote), audioLevelURI, "viewer")

	err = audioRemote.SetReadDeadline(time.Now().Add(readTimeout))
	if err != nil {
		t.Fatalf("read deadline: %v", err)
	}

	packet, _, err := audioRemote.ReadRTP()
	if err != nil {
		t.Fatalf("no audio RTP at viewer: %v", err)
	}

	assertOnlyExtension(t, packet, viewerLevelID)
}

// assertOnlyExtension checks that packet carries exactly one header
// extension, the audio level under wantID.
func assertOnlyExtension(t *testing.T, packet *rtp.Packet, wantID uint8) {
	t.Helper()

	ids := packet.GetExtensionIDs()
	if len(ids) != 1 || ids[0] != wantID {
		t.Fatalf("forwarded extension IDs = %v, want only the viewer's audio-level ID %d", ids, wantID)
	}

	level := packet.GetExtension(wantID)
	if len(level) != 1 || level[0] != audioLevelByte {
		t.Fatalf("audio-level payload = %x, want %x", level, audioLevelByte)
	}
}

// pumpRTPWithMid writes Opus-sized RTP packets carrying both an
// audio-level extension and a mid extension stamped with the
// publisher's own m-line numbering, the way a browser does.
func pumpRTPWithMid(track *webrtc.TrackLocalStaticRTP, levelID, midID uint8) {
	ticker := time.NewTicker(opusPacketMs * time.Millisecond)
	defer ticker.Stop()

	var seq uint16

	for range ticker.C {
		header := rtp.Header{Version: 2, SequenceNumber: seq, Timestamp: uint32(seq) * opusFrameTicks}
		packet := &rtp.Packet{Header: header, Payload: make([]byte, opusBytes)}

		err := packet.SetExtension(levelID, []byte{audioLevelByte})
		if err != nil {
			return
		}

		err = packet.SetExtension(midID, []byte("0"))
		if err != nil {
			return
		}

		err = track.WriteRTP(packet)
		if err != nil {
			return
		}

		seq++
	}
}

// pumpRTPWithExtension writes Opus-sized RTP packets carrying a one-byte
// audio-level extension until the track's connection closes.
func pumpRTPWithExtension(track *webrtc.TrackLocalStaticRTP, levelID uint8) {
	ticker := time.NewTicker(opusPacketMs * time.Millisecond)
	defer ticker.Stop()

	var seq uint16

	for range ticker.C {
		header := rtp.Header{Version: 2, SequenceNumber: seq, Timestamp: uint32(seq) * opusFrameTicks}
		packet := &rtp.Packet{Header: header, Payload: make([]byte, opusBytes)}

		err := packet.SetExtension(levelID, []byte{audioLevelByte})
		if err != nil {
			return
		}

		err = track.WriteRTP(packet)
		if err != nil {
			return
		}

		seq++
	}
}
