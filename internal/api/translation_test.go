package api_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stubbe/conference/internal/speech/service"
)

type translationPayload struct {
	Translation service.Status `json:"translation"`
}

func speechStatus(t *testing.T, env map[string]string) service.Status {
	t.Helper()

	settings, err := service.FromEnv(func(name string) string { return env[name] })
	if err != nil {
		t.Fatalf("speech settings from %v: %v", env, err)
	}

	return settings.Status()
}

func translationStatus(t *testing.T, handler http.Handler) service.Status {
	t.Helper()

	rec := do(t, handler, http.MethodGet, "/api/config", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d", rec.Code)
	}

	var payload translationPayload

	err := json.Unmarshal(rec.Body.Bytes(), &payload)
	if err != nil {
		t.Fatal(err)
	}

	return payload.Translation
}

func TestConfigTranslationNamesTheMissingEngines(t *testing.T) {
	t.Parallel()

	status := translationStatus(t, newTestServer(t))
	if status.Available || !strings.Contains(status.Reason, "TRANSLATE_MODEL") || len(status.Languages) == 0 {
		t.Fatalf("got %+v", status)
	}
}

func TestConfigTranslationAvailable(t *testing.T) {
	t.Parallel()

	server := newTranslatingAPI(t, testConfig(), speechStatus(t, map[string]string{"SPEECH_ENGINES": "fake"}))

	status := translationStatus(t, routes(server))
	if !status.Available || status.Reason != "" || status.External || status.Languages[0].Code != "en" {
		t.Fatalf("got %+v", status)
	}
}
