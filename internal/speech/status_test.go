package speech_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/stubbe/conference/internal/speech"
)

const (
	readyBody = `{"ready": true, "external": true,
		"engines": {"transcription": {"ready": true}, "translation": {"ready": true}, "voice": {"ready": true}},
		"languages": [{"code": "en", "name": "English"}, {"code": "de", "name": "German"}]}`
	notReadyBody = `{"ready": false, "external": false,
		"engines": {"transcription": {"ready": true},
			"translation": {"ready": false, "problem": "set TRANSLATE_MODEL to the Ollama model to translate with"},
			"voice": {"ready": true}},
		"languages": [{"code": "en", "name": "English"}]}`
)

func serve(t *testing.T, status int, body string) (*httptest.Server, *atomic.Int32) {
	t.Helper()

	var calls atomic.Int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)

		if r.URL.Path != "/v1/status" {
			http.NotFound(w, r)

			return
		}

		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)

	return server, &calls
}

func checker(t *testing.T, server *httptest.Server) *speech.Checker {
	t.Helper()

	streamURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/stream"

	checker, err := speech.NewChecker(streamURL, "", server.Client())
	if err != nil {
		t.Fatal(err)
	}

	return checker
}

func TestStatusURL(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"ws://localhost:8090/v1/stream":          "http://localhost:8090/v1/status",
		"wss://speech.example/v1/stream/":        "https://speech.example/v1/status",
		"wss://example.com/speech/v1/stream?x=1": "https://example.com/speech/v1/status",
	}
	for streamURL, want := range cases {
		got, err := speech.StatusURL(streamURL)
		if err != nil || got != want {
			t.Errorf("StatusURL(%q) = %q, %v; want %q", streamURL, got, err, want)
		}
	}

	_, err := speech.StatusURL("https://speech.example/v1/stream")
	if err == nil {
		t.Error("an http URL should be refused")
	}
}

func TestReady(t *testing.T) {
	t.Parallel()

	server, calls := serve(t, http.StatusOK, readyBody)
	status := checker(t, server).Status(t.Context())

	if !status.Available || status.Reason != "" || !status.External {
		t.Fatalf("got %+v, want available and external", status)
	}

	if len(status.Languages) != 2 || status.Languages[1].Code != "de" || status.Languages[1].Name != "German" {
		t.Fatalf("languages = %+v", status.Languages)
	}

	if calls.Load() != 1 {
		t.Fatalf("calls = %d", calls.Load())
	}
}

func TestCached(t *testing.T) {
	t.Parallel()

	server, calls := serve(t, http.StatusOK, readyBody)
	speechChecker := checker(t, server)

	speechChecker.Status(t.Context())
	speechChecker.Status(t.Context())

	if !speechChecker.Ready() || calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1 (cached)", calls.Load())
	}
}

func TestNotReady(t *testing.T) {
	t.Parallel()

	server, _ := serve(t, http.StatusOK, notReadyBody)
	status := checker(t, server).Status(t.Context())

	want := "Live translation needs a translation model to be set up on the speech service: " +
		"set TRANSLATE_MODEL to the Ollama model to translate with."
	if status.Available || status.Reason != want {
		t.Fatalf("got %+v, want reason %q", status, want)
	}

	if len(status.Languages) != 1 {
		t.Fatalf("languages = %+v, want the service's list even when not ready", status.Languages)
	}
}

func TestUnreachable(t *testing.T) {
	t.Parallel()

	server, _ := serve(t, http.StatusOK, readyBody)
	speechChecker := checker(t, server)
	server.Close()

	status := speechChecker.Status(t.Context())
	if status.Available || status.Reason != speech.ReasonUnreachable || status.Languages == nil {
		t.Fatalf("got %+v", status)
	}
}

func TestErrorStatus(t *testing.T) {
	t.Parallel()

	server, _ := serve(t, http.StatusInternalServerError, readyBody)

	status := checker(t, server).Status(t.Context())
	if status.Available || status.Reason != speech.ReasonUnreachable {
		t.Fatalf("got %+v", status)
	}
}

func TestStatusURLOverride(t *testing.T) {
	t.Parallel()

	server, calls := serve(t, http.StatusOK, readyBody)

	speechChecker, err := speech.NewChecker("wss://public.example/v1/stream", server.URL+"/v1/status", server.Client())
	if err != nil {
		t.Fatal(err)
	}

	if !speechChecker.Ready() || calls.Load() != 1 {
		t.Fatalf("calls = %d, want the override asked once", calls.Load())
	}
}

func TestNotConfigured(t *testing.T) {
	t.Parallel()

	var speechChecker *speech.Checker

	status := speechChecker.Status(t.Context())
	if status.Available || status.Reason != speech.ReasonNotConfigured || speechChecker.Ready() {
		t.Fatalf("got %+v", status)
	}
}
