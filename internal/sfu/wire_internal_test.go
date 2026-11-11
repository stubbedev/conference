package sfu

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/pion/webrtc/v4"

	"github.com/stubbe/conference/internal/relay"
)

const (
	anna      = "anna"
	downBo    = "down-bo"
	sampleSDP = "v=0"
)

func serverMessages() []Message {
	mid := "0"
	line := uint16(0)

	return []Message{
		{
			Type: msgWelcome,
			Self: &MemberInfo{ID: anna, Short: 1, Name: "Anna", Mic: true, Cam: false, Sharing: false},
			Members: []MemberInfo{
				{ID: "bo", Short: 2, Name: "Bo", Mic: false, Cam: true, Sharing: true},
			},
			ICEServers: []relay.ICEServer{
				{URLs: []string{"turn:127.0.0.1:3478?transport=udp"}, Username: anna, Credential: "secret"},
			},
			Resume: "resume-token", Recorder: "bo", TranslatingBy: "",
		},
		{Type: msgMemberJoined, ID: "cy", Short: 3, Name: "Cy", Replaces: "cy-before"},
		{Type: msgMemberLeft, ID: "cy"},
		{Type: msgMemberState, ID: "bo", Mic: true, Cam: false, Sharing: true},
		{Type: msgError, Code: "record-busy", Text: ErrRecordingActive.Error()},
		{Type: msgRecording, From: "bo", On: true},
		{Type: msgTranslating, From: anna, On: false},
		{Type: msgLayers, PC: UpstreamMedia.PCID(), Mid: "1", Active: []bool{true, false, true}},
		{Type: msgLang, From: "bo", IV: "iv", CT: "ct"},
		{Type: msgCaption, From: "bo", IV: "iv", CT: "ct"},
		{Type: msgChat, From: "bo", IV: "iv", CT: "ct", TS: 1_700_000_000_000},
		{Type: msgForced, Action: ActionMute},
		{Type: msgForced, Action: ActionLang, From: "bo", IV: "iv", CT: "ct"},
		{Type: msgKicked},
		{Type: msgAnswer, PC: UpstreamMedia.PCID(), SDP: sampleSDP},
		{
			Type: msgOffer, PC: downBo, SDP: sampleSDP,
			Tracks: []TrackInfo{{Mid: "0", Kind: KindCamera}, {Mid: "1", Kind: KindAudio}},
		},
		{
			Type: msgIce, PC: downBo,
			Candidate: &webrtc.ICECandidateInit{
				Candidate:        "candidate:1 1 udp 2130706431 127.0.0.1 5000 typ host",
				SDPMid:           &mid,
				SDPMLineIndex:    &line,
				UsernameFragment: nil,
			},
		},
		{Type: msgTranslateToken, Token: "speech-token"},
	}
}

func TestServerMessagesFixture(t *testing.T) {
	t.Parallel()

	matchesFixture(t, "signalling.json", serverMessages())
}

func TestOnlyServerMessagesAreWritten(t *testing.T) {
	t.Parallel()

	for _, msg := range []Message{
		{Type: msgJoin},
		{Type: msgWelcome},
		{Type: msgIce, PC: downBo},
	} {
		_, err := json.Marshal(msg)
		if !errors.Is(err, errNotServerMessage) {
			t.Errorf("%s message %+v: err = %v, want %v", msg.Type, msg, err, errNotServerMessage)
		}
	}
}
