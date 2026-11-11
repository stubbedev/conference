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
	Type          MessageType       `json:"type"`
	Self          MemberInfo        `json:"self"`
	Members       []MemberInfo      `json:"members"`
	ICEServers    []relay.ICEServer `json:"iceServers"`
	Resume        string            `json:"resume"`
	Recorder      string            `json:"recorder"`
	TranslatingBy string            `json:"translatingBy"`
}

type memberJoinedMessage struct {
	Type     MessageType `json:"type"`
	ID       string      `json:"id"`
	Short    uint32      `json:"short"`
	Name     string      `json:"name"`
	Replaces string      `json:"replaces"`
}

type memberLeftMessage struct {
	Type MessageType `json:"type"`
	ID   string      `json:"id"`
}

type memberStateMessage struct {
	Type    MessageType `json:"type"`
	ID      string      `json:"id"`
	Mic     bool        `json:"mic"`
	Cam     bool        `json:"cam"`
	Sharing bool        `json:"sharing"`
}

type errorMessage struct {
	Type MessageType `json:"type"`
	Code string      `json:"code"`
	Text string      `json:"text"`
}

type switchedMessage struct {
	Type MessageType `json:"type"`
	From string      `json:"from"`
	On   bool        `json:"on"`
}

type layersMessage struct {
	Type   MessageType `json:"type"`
	PC     string      `json:"pc"`
	Mid    string      `json:"mid"`
	Active []bool      `json:"active"`
}

type sealedMessage struct {
	Type MessageType `json:"type"`
	From string      `json:"from"`
	IV   string      `json:"iv"`
	CT   string      `json:"ct"`
}

type chatMessage struct {
	Type MessageType `json:"type"`
	From string      `json:"from"`
	IV   string      `json:"iv"`
	CT   string      `json:"ct"`
	TS   int64       `json:"ts"`
}

type forcedMessage struct {
	Type   MessageType `json:"type"`
	Action string      `json:"action"`
}

type forcedLangMessage struct {
	Type   MessageType `json:"type"`
	Action string      `json:"action"`
	From   string      `json:"from"`
	IV     string      `json:"iv"`
	CT     string      `json:"ct"`
}

type kickedMessage struct {
	Type MessageType `json:"type"`
}

type answerMessage struct {
	Type MessageType `json:"type"`
	PC   string      `json:"pc"`
	SDP  string      `json:"sdp"`
}

type offerMessage struct {
	Type   MessageType `json:"type"`
	PC     string      `json:"pc"`
	SDP    string      `json:"sdp"`
	Tracks []TrackInfo `json:"tracks"`
}

type iceMessage struct {
	Type      MessageType             `json:"type"`
	PC        string                  `json:"pc"`
	Candidate webrtc.ICECandidateInit `json:"candidate"`
}

type tokenMessage struct {
	Type  MessageType `json:"type"`
	Token string      `json:"token"`
}

// MarshalJSON writes a message to a member in its type's own shape.
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

func (msg Message) shaped() (any, error) { //nolint:cyclop // one flat case per signaling message type.
	switch msg.Type {
	case msgWelcome:
		if msg.Self == nil {
			return nil, fmt.Errorf("%w: a welcome without the member it welcomes", errNotServerMessage)
		}

		return welcomeMessage{
			Type: msg.Type, Self: *msg.Self, Members: msg.Members, ICEServers: msg.ICEServers,
			Resume: msg.Resume, Recorder: msg.Recorder, TranslatingBy: msg.TranslatingBy,
		}, nil
	case msgMemberJoined:
		return memberJoinedMessage{Type: msg.Type, ID: msg.ID, Short: msg.Short, Name: msg.Name, Replaces: msg.Replaces}, nil
	case msgMemberLeft:
		return memberLeftMessage{Type: msg.Type, ID: msg.ID}, nil
	case msgMemberState:
		return memberStateMessage{Type: msg.Type, ID: msg.ID, Mic: msg.Mic, Cam: msg.Cam, Sharing: msg.Sharing}, nil
	case msgError:
		return errorMessage{Type: msg.Type, Code: msg.Code, Text: msg.Text}, nil
	case msgRecording, msgTranslating:
		return switchedMessage{Type: msg.Type, From: msg.From, On: msg.On}, nil
	case msgLayers:
		return layersMessage{Type: msg.Type, PC: msg.PC, Mid: msg.Mid, Active: msg.Active}, nil
	case msgLang, msgCaption:
		return sealedMessage{Type: msg.Type, From: msg.From, IV: msg.IV, CT: msg.CT}, nil
	case msgChat:
		return chatMessage{Type: msg.Type, From: msg.From, IV: msg.IV, CT: msg.CT, TS: msg.TS}, nil
	case msgForced:
		if msg.Action == ActionLang {
			return forcedLangMessage{Type: msg.Type, Action: msg.Action, From: msg.From, IV: msg.IV, CT: msg.CT}, nil
		}

		return forcedMessage{Type: msg.Type, Action: msg.Action}, nil
	case msgKicked:
		return kickedMessage{Type: msg.Type}, nil
	case msgAnswer:
		return answerMessage{Type: msg.Type, PC: msg.PC, SDP: msg.SDP}, nil
	case msgOffer:
		return offerMessage{Type: msg.Type, PC: msg.PC, SDP: msg.SDP, Tracks: msg.Tracks}, nil
	case msgIce:
		if msg.Candidate == nil {
			return nil, fmt.Errorf("%w: an ice message without a candidate", errNotServerMessage)
		}

		return iceMessage{Type: msg.Type, PC: msg.PC, Candidate: *msg.Candidate}, nil
	case msgTranslateToken:
		return tokenMessage{Type: msg.Type, Token: msg.Token}, nil
	case msgJoin, msgClose, msgPli, msgState, msgRecord, msgModerate, msgLayer, msgTranslate, msgTranslateTokenRequest:
		return nil, fmt.Errorf("%w: %q is sent by members", errNotServerMessage, msg.Type)
	default:
		return nil, fmt.Errorf("%w: %q", errNotServerMessage, msg.Type)
	}
}
