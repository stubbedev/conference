package sfu

import (
	"testing"
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
