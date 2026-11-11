package sfu

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/pion/webrtc/v4"

	"github.com/stubbe/conference/internal/relay"
)

var errNotServerMessage = errors.New("sfu: not a message the server sends")

type welcomeMessage struct {
	Type          string            `json:"type"`
	Self          MemberInfo        `json:"self"`
	Members       []MemberInfo      `json:"members"`
	ICEServers    []relay.ICEServer `json:"iceServers"`
	Resume        string            `json:"resume"`
	Recorder      string            `json:"recorder"`
	TranslatingBy string            `json:"translatingBy"`
}

type memberJoinedMessage struct {
	Type     string `json:"type"`
	ID       string `json:"id"`
	Short    uint32 `json:"short"`
	Name     string `json:"name"`
	Replaces string `json:"replaces"`
}

type memberLeftMessage struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type memberStateMessage struct {
	Type    string `json:"type"`
	ID      string `json:"id"`
	Mic     bool   `json:"mic"`
	Cam     bool   `json:"cam"`
	Sharing bool   `json:"sharing"`
}

type errorMessage struct {
	Type string `json:"type"`
	Code string `json:"code"`
	Text string `json:"text"`
}

type switchedMessage struct {
	Type string `json:"type"`
	From string `json:"from"`
	On   bool   `json:"on"`
}

type layersMessage struct {
	Type   string `json:"type"`
	PC     string `json:"pc"`
	Mid    string `json:"mid"`
	Active []bool `json:"active"`
}

type sealedMessage struct {
	Type string `json:"type"`
	From string `json:"from"`
	IV   string `json:"iv"`
	CT   string `json:"ct"`
}

type chatMessage struct {
	Type string `json:"type"`
	From string `json:"from"`
	IV   string `json:"iv"`
	CT   string `json:"ct"`
	TS   int64  `json:"ts"`
}

type forcedMessage struct {
	Type   string `json:"type"`
	Action string `json:"action"`
}

type forcedLangMessage struct {
	Type   string `json:"type"`
	Action string `json:"action"`
	From   string `json:"from"`
	IV     string `json:"iv"`
	CT     string `json:"ct"`
}

type kickedMessage struct {
	Type string `json:"type"`
}

type answerMessage struct {
	Type string `json:"type"`
	PC   string `json:"pc"`
	SDP  string `json:"sdp"`
}

type offerMessage struct {
	Type   string      `json:"type"`
	PC     string      `json:"pc"`
	SDP    string      `json:"sdp"`
	Tracks []TrackInfo `json:"tracks"`
}

type iceMessage struct {
	Type      string                  `json:"type"`
	PC        string                  `json:"pc"`
	Candidate webrtc.ICECandidateInit `json:"candidate"`
}

type tokenMessage struct {
	Type  string `json:"type"`
	Token string `json:"token"`
}

func (msg Message) MarshalJSON() ([]byte, error) {
	shaped, err := msg.shaped()
	if err != nil {
		return nil, err
	}

	data, err := json.Marshal(shaped)
	if err != nil {
		return nil, fmt.Errorf("sfu: encode %s message: %w", msg.Type, err)
	}

	return data, nil
}

func (msg Message) shaped() (any, error) { //nolint:cyclop,funlen // one flat case per signaling message type.
	switch msg.Type {
	case "welcome":
		if msg.Self == nil {
			return nil, fmt.Errorf("%w: a welcome without the member it welcomes", errNotServerMessage)
		}

		return welcomeMessage{
			Type: msg.Type, Self: *msg.Self, Members: msg.Members, ICEServers: msg.ICEServers,
			Resume: msg.Resume, Recorder: msg.Recorder, TranslatingBy: msg.TranslatingBy,
		}, nil
	case "member-joined":
		return memberJoinedMessage{Type: msg.Type, ID: msg.ID, Short: msg.Short, Name: msg.Name, Replaces: msg.Replaces}, nil
	case "member-left":
		return memberLeftMessage{Type: msg.Type, ID: msg.ID}, nil
	case "member-state":
		return memberStateMessage{Type: msg.Type, ID: msg.ID, Mic: msg.Mic, Cam: msg.Cam, Sharing: msg.Sharing}, nil
	case "error":
		return errorMessage{Type: msg.Type, Code: msg.Code, Text: msg.Text}, nil
	case "recording", "translating":
		return switchedMessage{Type: msg.Type, From: msg.From, On: msg.On}, nil
	case "layers":
		return layersMessage{Type: msg.Type, PC: msg.PC, Mid: msg.Mid, Active: msg.Active}, nil
	case "lang", "caption":
		return sealedMessage{Type: msg.Type, From: msg.From, IV: msg.IV, CT: msg.CT}, nil
	case "chat":
		return chatMessage{Type: msg.Type, From: msg.From, IV: msg.IV, CT: msg.CT, TS: msg.TS}, nil
	case "forced":
		if msg.Action == ActionLang {
			return forcedLangMessage{Type: msg.Type, Action: msg.Action, From: msg.From, IV: msg.IV, CT: msg.CT}, nil
		}

		return forcedMessage{Type: msg.Type, Action: msg.Action}, nil
	case "kicked":
		return kickedMessage{Type: msg.Type}, nil
	case "answer":
		return answerMessage{Type: msg.Type, PC: msg.PC, SDP: msg.SDP}, nil
	case "offer":
		return offerMessage{Type: msg.Type, PC: msg.PC, SDP: msg.SDP, Tracks: msg.Tracks}, nil
	case "ice":
		if msg.Candidate == nil {
			return nil, fmt.Errorf("%w: an ice message without a candidate", errNotServerMessage)
		}

		return iceMessage{Type: msg.Type, PC: msg.PC, Candidate: *msg.Candidate}, nil
	case "translate-token":
		return tokenMessage{Type: msg.Type, Token: msg.Token}, nil
	default:
		return nil, fmt.Errorf("%w: %q", errNotServerMessage, msg.Type)
	}
}
