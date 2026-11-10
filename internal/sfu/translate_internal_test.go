package sfu

import (
	"testing"
)

const translationDE = Kind(KindTranslationPrefix + "de")

func TestTranslationTracksAreAudio(t *testing.T) {
	t.Parallel()

	for kind, audio := range map[Kind]bool{
		KindAudio:       true,
		KindScreenAudio: true,
		translationDE:   true,
		KindCamera:      false,
		KindScreen:      false,
	} {
		if kind.audio() != audio {
			t.Errorf("kind %q: audio() = %v, want %v", kind, !audio, audio)
		}
	}
}

func TestOnlyTheClientsKindsAreKnown(t *testing.T) {
	t.Parallel()

	for kind, known := range map[Kind]bool{
		KindAudio:                   true,
		KindCamera:                  true,
		KindScreen:                  true,
		KindScreenAudio:             true,
		translationDE:               true,
		Kind(KindTranslationPrefix): false,
		"unknown":                   false,
		"":                          false,
	} {
		if kind.known() != known {
			t.Errorf("kind %q: known() = %v, want %v", kind, !known, known)
		}
	}
}
