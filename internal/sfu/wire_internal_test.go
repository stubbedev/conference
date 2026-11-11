package sfu

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/pion/webrtc/v4"

	"github.com/stubbe/conference/internal/relay"
)

func serverMessages() []Message {
	mid := "0"
	line := uint16(0)

	return []Message{
		{
			Type: "welcome",
			Self: &MemberInfo{ID: "anna", Short: 1, Name: "Anna", Mic: true, Cam: false, Sharing: false},
			Members: []MemberInfo{
				{ID: "bo", Short: 2, Name: "Bo", Mic: false, Cam: true, Sharing: true},
			},
			ICEServers: []relay.ICEServer{
				{URLs: []string{"turn:127.0.0.1:3478?transport=udp"}, Username: "anna", Credential: "secret"},
			},
			Resume: "resume-token", Recorder: "bo", TranslatingBy: "",
		},
		{Type: "member-joined", ID: "cy", Short: 3, Name: "Cy", Replaces: "cy-before"},
		{Type: "member-left", ID: "cy"},
		{Type: "member-state", ID: "bo", Mic: true, Cam: false, Sharing: true},
		{Type: "error", Code: "record-busy", Text: ErrRecordingActive.Error()},
		{Type: "recording", From: "bo", On: true},
		{Type: "translating", From: "anna", On: false},
		{Type: "layers", PC: UpstreamMedia.PCID(), Mid: "1", Active: []bool{true, false, true}},
		{Type: "lang", From: "bo", IV: "iv", CT: "ct"},
		{Type: "caption", From: "bo", IV: "iv", CT: "ct"},
		{Type: "chat", From: "bo", IV: "iv", CT: "ct", TS: 1_700_000_000_000},
		{Type: "forced", Action: ActionMute},
		{Type: "forced", Action: ActionLang, From: "bo", IV: "iv", CT: "ct"},
		{Type: "kicked"},
		{Type: "answer", PC: UpstreamMedia.PCID(), SDP: "v=0"},
		{
			Type: "offer", PC: "down-bo", SDP: "v=0",
			Tracks: []TrackInfo{{Mid: "0", Kind: KindCamera}, {Mid: "1", Kind: KindAudio}},
		},
		{
			Type: "ice", PC: "down-bo",
			Candidate: &webrtc.ICECandidateInit{
				Candidate:        "candidate:1 1 udp 2130706431 127.0.0.1 5000 typ host",
				SDPMid:           &mid,
				SDPMLineIndex:    &line,
				UsernameFragment: nil,
			},
		},
		{Type: "translate-token", Token: "speech-token"},
	}
}

func TestServerMessagesFixture(t *testing.T) {
	t.Parallel()

	matchesFixture(t, "signalling.json", serverMessages())
}

func TestOnlyServerMessagesAreWritten(t *testing.T) {
	t.Parallel()

	for _, msg := range []Message{
		{Type: "join"},
		{Type: "welcome"},
		{Type: "ice", PC: "down-bo"},
	} {
		_, err := json.Marshal(msg)
		if !errors.Is(err, errNotServerMessage) {
			t.Errorf("%s message %+v: err = %v, want %v", msg.Type, msg, err, errNotServerMessage)
		}
	}
}
