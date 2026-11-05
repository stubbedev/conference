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
	TypeHello             = "hello"
	TypeEnd               = "end"
	TypeReady             = "ready"
	TypeCaption           = "caption"
	TypeNotice            = "notice"
	NoticeTranslateFailed = "translation-failed"
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
}

// VoiceHeader heads the service's frame of translated voice.
type VoiceHeader struct {
	Speaker string `json:"speaker"`
	SegID   string `json:"segId"`
	Lang    string `json:"lang"`
	Rate    int    `json:"rate"`
}

// Command is a client's text message: hello with its target languages,
// or end when a speaker's stream stops.
type Command struct {
	Type    string   `json:"type"`
	Targets []string `json:"targets,omitempty"`
	Speaker string   `json:"speaker,omitempty"`
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

// Notice tells the client something went wrong without ending the stream.
type Notice struct {
	Type string `json:"type"`
	Code string `json:"code"`
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
