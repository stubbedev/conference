// Package wire is the speech service's WebSocket protocol. Binary frames
// are a 2-byte big-endian header length, a JSON header and PCM16
// little-endian mono samples; text frames are JSON messages.
package wire

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
)

const headerLength = 2

// Message types and the notice code a client acts on.
const (
	TypeHello = "hello"
	TypeEnd   = "end"
	// TypeVoiceSample ends a voice sample the speaker recorded, sent
	// ahead in audio frames marked Sample.
	TypeVoiceSample = "voice-sample"
	// TypeForgetVoice drops the speaker's recorded voice at once: they
	// deleted it or chose a stock voice.
	TypeForgetVoice       = "forget-voice"
	TypeReady             = "ready"
	TypeCaption           = "caption"
	TypeNotice            = "notice"
	NoticeTranslateFailed = "translation-failed"
	// NoticeOwnVoiceReady: the speaker's recorded voice is in use.
	NoticeOwnVoiceReady = "own-voice-ready"
	// NoticeOwnVoiceRejected: a recorded voice sample was too short or
	// held no speech; the stock voice speaks.
	NoticeOwnVoiceRejected = "own-voice-rejected"
)

var (
	errShortFrame    = errors.New("wire: frame header runs past the frame")
	errHeaderTooLong = errors.New("wire: frame header too long")
)

// AudioHeader heads a client's frame of microphone audio at 16 kHz.
type AudioHeader struct {
	Speaker string `json:"speaker"`
	Lang    string `json:"lang"`
	Voice   string `json:"voice"`
	// Sample marks audio of a voice sample the speaker recorded, not live
	// speech.
	Sample bool `json:"sample,omitempty"`
}

// VoiceHeader heads the service's frame of translated voice.
type VoiceHeader struct {
	Speaker string `json:"speaker"`
	SegID   string `json:"segId"`
	Lang    string `json:"lang"`
	Rate    int    `json:"rate"`
	// Cloned is true when the voice is the speaker's own, cloned one.
	Cloned bool `json:"cloned,omitempty"`
}

// Command is a client's text message: hello with its target languages,
// end when a speaker's stream stops, or voice-sample after a recorded
// voice sample. VoiceTargets, when present, are
// the targets someone wants to hear a translated voice in; without it
// every target gets one.
type Command struct {
	Type         string   `json:"type"`
	Targets      []string `json:"targets,omitempty"`
	VoiceTargets []string `json:"voiceTargets,omitempty"`
	Speaker      string   `json:"speaker,omitempty"`
	// Lang is the language a voice sample is spoken in.
	Lang string `json:"lang,omitempty"`
}

// Caption is a subtitle in one language; Final is false while the
// speaker is still talking.
type Caption struct {
	Type       string `json:"type"`
	Speaker    string `json:"speaker"`
	SegID      string `json:"segId"`
	SourceLang string `json:"sourceLang"`
	Lang       string `json:"lang"`
	Text       string `json:"text"`
	Final      bool   `json:"final"`
}

// Notice tells the client about its stream without ending it: a
// sentence sent untranslated, or whether its recorded voice is in use.
type Notice struct {
	Type    string  `json:"type"`
	Code    string  `json:"code"`
	Seconds float64 `json:"seconds,omitempty"`
}

// Pack builds a binary frame from a header and PCM16 samples.
func Pack(header any, pcm []byte) ([]byte, error) {
	encoded, err := json.Marshal(header)
	if err != nil {
		return nil, fmt.Errorf("wire: encode the frame header: %w", err)
	}

	size := len(encoded)
	if size > math.MaxUint16 {
		return nil, fmt.Errorf("%w: %d bytes", errHeaderTooLong, size)
	}

	return slices.Concat(binary.BigEndian.AppendUint16(nil, uint16(size)), encoded, pcm), nil
}

// Unpack decodes a binary frame's header into header and returns its PCM16 samples.
func Unpack(frame []byte, header any) ([]byte, error) {
	if len(frame) < headerLength {
		return nil, errShortFrame
	}

	end := headerLength + int(binary.BigEndian.Uint16(frame))
	if end > len(frame) {
		return nil, errShortFrame
	}

	err := json.Unmarshal(frame[headerLength:end], header)
	if err != nil {
		return nil, fmt.Errorf("wire: decode the frame header: %w", err)
	}

	return frame[end:], nil
}

// Language is one language the service speaks.
type Language struct {
	Code string `json:"code"`
	Name string `json:"name"`
}
