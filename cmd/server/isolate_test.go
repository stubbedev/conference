package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEveryResponseIsCrossOriginIsolated(t *testing.T) {
	t.Parallel()

	handler := isolate(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))

	for _, path := range []string{"/", "/api/config", "/speech/piper/en.onnx"} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), http.MethodGet, path, nil))

		headers := recorder.Result().Header
		if got := headers.Get("Cross-Origin-Opener-Policy"); got != "same-origin" {
			t.Errorf("%s: Cross-Origin-Opener-Policy %q, want same-origin", path, got)
		}

		if got := headers.Get("Cross-Origin-Embedder-Policy"); got != "credentialless" {
			t.Errorf("%s: Cross-Origin-Embedder-Policy %q, want credentialless", path, got)
		}
	}
}
