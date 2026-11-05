package wav_test

import (
	"slices"
	"testing"

	"github.com/stubbe/conference/internal/speech/wav"
)

func encode(t *testing.T, pcm []int16, rate uint32) []byte {
	t.Helper()

	data, err := wav.Encode(pcm, rate)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	return data
}

func TestRoundTrip(t *testing.T) {
	t.Parallel()

	pcm := []int16{0, 1, -1, 32767, -32768, 1234}

	got, rate, err := wav.Decode(encode(t, pcm, 24000))
	if err != nil {
		t.Fatalf("decode: %v", err)
	}

	if rate != 24000 || !slices.Equal(got, pcm) {
		t.Fatalf("got %v at %d Hz, want %v at 24000 Hz", got, rate, pcm)
	}
}

func TestDecodeRejects(t *testing.T) {
	t.Parallel()

	valid := encode(t, []int16{1, 2, 3}, 16000)

	stereo := slices.Clone(valid)
	stereo[22] = 2

	cases := map[string][]byte{
		"empty":     nil,
		"not riff":  []byte("RIFX0000WAVE"),
		"stereo":    stereo,
		"truncated": valid[:len(valid)-2],
	}

	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			_, _, err := wav.Decode(data)
			if err == nil {
				t.Fatal("decoded, want an error")
			}
		})
	}
}
