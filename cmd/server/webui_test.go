package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/stubbe/conference/internal/config"
	"github.com/stubbe/conference/internal/relay"
)

const (
	primaryOrigin = "https://meet.example.com"
	otherOrigin   = "https://meet.example.org"
)

func testConfig(base string, others ...string) *config.Config {
	return &config.Config{
		HTTPAddr:           "",
		BaseURL:            base,
		PublicOrigins:      others,
		DBPath:             "",
		APIKeys:            nil,
		JoinOnly:           false,
		SlackSigningSecret: "",
		OpenCreateHosts:    nil,
		ICEUDPPort:         0,
		ExternalIPs:        nil,
		Relay:              relay.Config{Port: 0, TLSHost: ""},
		MaxPublishKbps:     0,
		TrustedProxies:     nil,
		AllowedOrigins:     nil,
		SessionTTL:         0,
		MaxRoomMembers:     0,
		RoomTTL:            0,
	}
}

func file(data string) *fstest.MapFile {
	return &fstest.MapFile{Data: []byte(data), Mode: 0, ModTime: time.Time{}, Sys: nil}
}

func newTestUI(t *testing.T) http.Handler {
	t.Helper()

	frontend, err := newWebUI(testConfig(primaryOrigin, otherOrigin), fstest.MapFS{
		indexPage:             file(indexFixture),
		"assets/index-abc.js": file("console.log(1)"),
		"logo.svg":            file("<svg/>"),
	})
	if err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	frontend.routes(mux)

	return mux
}

func get(handler http.Handler, method, target, host string) *httptest.ResponseRecorder {
	req := httptest.NewRequestWithContext(context.Background(), method, target, nil)
	req.Host = host

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	return rec
}

func TestWebUIServesAppOnClientRoutes(t *testing.T) {
	t.Parallel()

	handler := newTestUI(t)

	for _, target := range []string{"/", "/r/abc-def-ghi"} {
		rec := get(handler, http.MethodGet, target, "meet.example.com")
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `content="`+primaryOrigin+`/og-image.png"`) {
			t.Fatalf("%s: status %d body %s", target, rec.Code, rec.Body.String())
		}

		if rec.Header().Get("Cache-Control") != "no-cache" {
			t.Fatalf("%s: Cache-Control %q", target, rec.Header().Get("Cache-Control"))
		}
	}
}

func TestWebUIPreviewURLsFollowOrigin(t *testing.T) {
	t.Parallel()

	handler := newTestUI(t)

	for host, origin := range map[string]string{
		"meet.example.org": otherOrigin,
		"meet.example.com": primaryOrigin,
		"forged.example":   primaryOrigin,
	} {
		body := get(handler, http.MethodGet, "/r/abc-def-ghi", host).Body.String()
		if !strings.Contains(body, `property="og:image" content="`+origin+`/og-image.png"`) {
			t.Errorf("host %s: want preview on %s, got %s", host, origin, body)
		}
	}
}

func TestWebUIServesFiles(t *testing.T) {
	t.Parallel()

	handler := newTestUI(t)

	rec := get(handler, http.MethodGet, "/assets/index-abc.js", "meet.example.com")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("asset: status %d Cache-Control %q", rec.Code, rec.Header().Get("Cache-Control"))
	}

	rec = get(handler, http.MethodHead, "/logo.svg", "meet.example.com")
	if rec.Code != http.StatusOK || rec.Header().Get("Cache-Control") != "" {
		t.Fatalf("logo: status %d Cache-Control %q", rec.Code, rec.Header().Get("Cache-Control"))
	}
}

func TestWebUIRejectsEverythingElse(t *testing.T) {
	t.Parallel()

	handler := newTestUI(t)

	for _, tc := range []struct {
		method, target string
		want           int
	}{
		{http.MethodGet, "/icons.svg", http.StatusNotFound},
		{http.MethodGet, "/assets/", http.StatusNotFound},
		{http.MethodGet, "/assets", http.StatusNotFound},
		{http.MethodGet, "/r/", http.StatusNotFound},
		{http.MethodGet, "/nope", http.StatusNotFound},
		{http.MethodPost, "/", http.StatusMethodNotAllowed},
		{http.MethodPost, "/logo.svg", http.StatusMethodNotAllowed},
	} {
		rec := get(handler, tc.method, tc.target, "meet.example.com")
		if rec.Code != tc.want {
			t.Errorf("%s %s: got %d, want %d", tc.method, tc.target, rec.Code, tc.want)
		}
	}
}

func TestWebUIRequiresBuiltIndex(t *testing.T) {
	t.Parallel()

	_, err := newWebUI(testConfig(primaryOrigin), fstest.MapFS{})
	if err == nil {
		t.Fatal("accepted a dist without index.html")
	}
}
