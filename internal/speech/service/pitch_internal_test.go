package service

import (
	"math"
	"testing"

	"github.com/stubbe/conference/internal/speech/vad"
)

// voiced is seconds of a vowel-like sound at pitch: the fundamental and
// harmonics of falling strength, the second one as given.
func voiced(pitch, second float64, seconds int) []int16 {
	audio := make([]int16, seconds*vad.Rate)

	for i := range audio {
		at := 2 * math.Pi * pitch * float64(i) / vad.Rate
		value := math.Sin(at) + second*math.Sin(2*at) + 0.3*math.Sin(3*at) + 0.2*math.Sin(4*at)
		audio[i] = int16(4000 * value)
	}

	return audio
}

func TestMedianPitch(t *testing.T) {
	t.Parallel()

	for _, want := range []float64{90, 110, 150, 210, 260} {
		got, ok := medianPitch(voiced(want, 0.5, 2))
		if !ok || math.Abs(got-want) > want*0.03 {
			t.Errorf("a %.0f Hz voice measured %.1f Hz (ok %t)", want, got, ok)
		}
	}

	// A strong second harmonic is not the pitch, nor is the octave below.
	if got, ok := medianPitch(voiced(120, 1.5, 2)); !ok || math.Abs(got-120) > 4 {
		t.Errorf("a 120 Hz voice with a strong second harmonic measured %.1f Hz (ok %t)", got, ok)
	}

	if _, ok := medianPitch(make([]int16, 2*vad.Rate)); ok {
		t.Error("silence has a pitch")
	}
}

func TestClosestStock(t *testing.T) {
	t.Parallel()

	for pitch, want := range map[float64]voiceChoice{100: voiceMale, 140: voiceMale, 190: voiceFemale, 240: voiceFemale} {
		if got := closestStock(voiced(pitch, 0.5, 2)); got != want {
			t.Errorf("a %.0f Hz speaker starts from %s, want %s", pitch, got, want)
		}
	}

	if got := closestStock(make([]int16, vad.Rate)); got != defaultVoice {
		t.Errorf("a recording without a voice starts from %s, want the default", got)
	}
}
