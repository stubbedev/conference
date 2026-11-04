package api_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stubbe/conference/internal/speech"
)

type translationPayload struct {
	Translation speech.Status `json:"translation"`
}

func translationStatus(t *testing.T, handler http.Handler) speech.Status {
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

func TestConfigTranslationWithoutSpeechService(t *testing.T) {
	t.Parallel()

	status := translationStatus(t, newTestServer(t))
	if status.Available || status.Reason != speech.ReasonNotConfigured || status.Languages == nil {
		t.Fatalf("got %+v", status)
	}
}

func TestConfigTranslationFromSpeechService(t *testing.T) {
	t.Parallel()

	speechService := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"ready": false, "external": true,
			"engines": {"translation": {"ready": false, "problem": "set TRANSLATE_MODEL"}},
			"languages": [{"code": "en", "name": "English"}, {"code": "sv", "name": "Swedish"}]}`))
	}))
	t.Cleanup(speechService.Close)

	checker, err := speech.NewChecker("ws"+strings.TrimPrefix(speechService.URL, "http")+"/v1/stream", "", speechService.Client())
	if err != nil {
		t.Fatal(err)
	}

	server := newTestAPI(t, testConfig())
	server.Speech = checker

	status := translationStatus(t, routes(server))
	if status.Available || !status.External || !strings.Contains(status.Reason, "translation model") {
		t.Fatalf("got %+v", status)
	}

	if len(status.Languages) != 2 || status.Languages[1].Code != "sv" {
		t.Fatalf("languages = %+v", status.Languages)
	}
}
