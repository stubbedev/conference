package sfu

import (
	"testing"
	"time"
)

func TestTranslationTracksAreAudio(t *testing.T) {
	t.Parallel()

	for kind, audio := range map[string]bool{
		KindAudio:                    true,
		KindTranslationPrefix + "de": true,
		KindCamera:                   false,
		KindScreen:                   false,
		"unknown":                    false,
	} {
		if isAudioKind(kind) != audio {
			t.Errorf("kind %q: isAudioKind() = %v, want %v", kind, !audio, audio)
		}
	}
}

// TestSpeechTokenVector pins the token format the speech service verifies.
func TestSpeechTokenVector(t *testing.T) {
	t.Parallel()

	got := mintSpeechToken([]byte("secret"), "room", "member", time.Unix(1_000_000_000, 0))
	want := "eyJyb29tIjoicm9vbSIsIm1lbWJlciI6Im1lbWJlciIsImV4cCI6MTAwMDAwMzYwMH0.-ycrBJy64UzIbCMPyi4X5xLG1BlcZ0sZD-da7aA6ywY"

	if got != want {
		t.Fatalf("token %q, want %q", got, want)
	}
}
