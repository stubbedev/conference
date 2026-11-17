package main

import (
	"testing"

	"github.com/stubbe/conference/internal/speech/service"
)

// nothing is what a speech service reports before it is set up.
func nothing() service.Status {
	return service.Status{
		Available: false,
		Reason:    "",
		Mode:      "",
		Fake:      false,
		Models:    nil,
		Languages: nil,
		External:  false,
		OwnVoice:  false,
	}
}

// TestSpeechTokensOnlyFromARunningService pins the nil a typed nil hides:
// a browser runtime has no speech service, and the SFU must see no stream
// source rather than an interface holding a nil pointer.
func TestSpeechTokensOnlyFromARunningService(t *testing.T) {
	t.Parallel()

	browsers := liveTranslation{status: nothing(), streams: nil, models: nil}
	if browsers.tokens() != nil {
		t.Fatal("a browser runtime offers speech tokens")
	}

	settings, err := service.FromEnv(func(name string) string {
		if name == "SPEECH_ENGINES" {
			return "fake"
		}

		return ""
	})
	if err != nil {
		t.Fatalf("settings: %v", err)
	}

	streams, models, err := service.Start(settings, nil)
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	if streams == nil || models != nil {
		t.Fatalf("started %v and %v, want the speech service alone", streams, models)
	}

	server := liveTranslation{status: nothing(), streams: streams, models: nil}
	if server.tokens() == nil {
		t.Fatal("a server runtime offers no speech tokens")
	}
}
