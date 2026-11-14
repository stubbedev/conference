package wire_test

import (
	"bytes"
	"testing"

	"github.com/stubbe/conference/internal/speech/wire"
)

func TestPackUnpack(t *testing.T) {
	t.Parallel()

	sent := wire.VoiceHeader{Speaker: "anna", SegID: "anna-3", Lang: "fr", Rate: 24000, Cloned: false}
	pcm := []byte{1, 0, 2, 0}

	frame, err := wire.Pack(sent, pcm)
	if err != nil {
		t.Fatalf("pack: %v", err)
	}

	var got wire.VoiceHeader

	rest, err := wire.Unpack(frame, &got)
	if err != nil {
		t.Fatalf("unpack: %v", err)
	}

	if got != sent || !bytes.Equal(rest, pcm) {
		t.Fatalf("got %+v with %v, want %+v with %v", got, rest, sent, pcm)
	}
}

func TestUnpackRejectsShortFrames(t *testing.T) {
	t.Parallel()

	var header wire.AudioHeader

	for _, frame := range [][]byte{nil, {0}, {0, 9, '{'}, {0, 1, '{'}} {
		_, err := wire.Unpack(frame, &header)
		if err == nil {
			t.Fatalf("%v unpacked, want an error", frame)
		}
	}
}
