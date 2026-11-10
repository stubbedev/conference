package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stubbe/conference/internal/api"
	"github.com/stubbe/conference/internal/config"
	"github.com/stubbe/conference/internal/relay"
	"github.com/stubbe/conference/internal/sfu"
	"github.com/stubbe/conference/internal/speech/service"
	"github.com/stubbe/conference/internal/store"
)

const (
	openHost     = "stubbe.dev"
	joinOnlyHost = "mariabugge.com"
	operatorKey  = "s3cret"
	forwardedFor = "X-Forwarded-For"
)

func testConfig() *config.Config {
	return &config.Config{
		HTTPAddr:           "",
		BaseURL:            "",
		PublicOrigins:      nil,
		DBPath:             "",
		APIKeys:            []string{operatorKey},
		JoinOnly:           true,
		SlackSigningSecret: "",
		OpenCreateHosts:    []string{openHost},
		ICEUDPPort:         0,
		ExternalIPs:        nil,
		Relay:              relay.Config{Port: 3478, TLSHost: ""},
		TrustedProxies:     nil,
		AllowedOrigins:     nil,
		SessionTTL:         365 * 24 * time.Hour,
		MaxRoomMembers:     0,
		RoomTTL:            0,
	}
}

func newTestAPI(t *testing.T, cfg *config.Config) *api.Server {
	t.Helper()

	return newTranslatingAPI(t, cfg, speechStatus(t, nil))
}

func newTranslatingAPI(t *testing.T, cfg *config.Config, translation service.Status) *api.Server {
	t.Helper()

	storage, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = storage.Close() })

	engine, closeEngine, err := sfu.NewEngine(0, nil)
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(closeEngine)

	creds, err := relay.NewCredentials(cfg.Relay)
	if err != nil {
		t.Fatal(err)
	}

	hub := sfu.NewHub(sfu.HubConfig{
		Engine:     engine,
		Relay:      creds,
		MaxMembers: 0,
		Speech:     nil,
		Translate:  false,
	})

	return api.New(storage, hub, cfg, translation)
}

func routes(server *api.Server) http.Handler {
	mux := http.NewServeMux()
	server.Routes(mux)

	return mux
}

func newTestServer(t *testing.T) http.Handler {
	t.Helper()

	return routes(newTestAPI(t, testConfig()))
}

func do(t *testing.T, handler http.Handler, method, target, host string) *httptest.ResponseRecorder {
	t.Helper()

	req := httptest.NewRequestWithContext(
		context.Background(), method, target, bytes.NewReader([]byte(`{"name":"Test"}`)),
	)
	req.Host = host

	rec := httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	return rec
}

func TestCreateRoomOpenHost(t *testing.T) {
	t.Parallel()

	handler := newTestServer(t)

	for _, host := range []string{openHost, "STUBBE.DEV", openHost + ":8443"} {
		rec := do(t, handler, http.MethodPost, "/api/rooms", host)
		if rec.Code != http.StatusCreated {
			t.Fatalf("host %s: got status %d, want %d", host, rec.Code, http.StatusCreated)
		}
	}
}

func TestCreateRoomJoinOnlyHost(t *testing.T) {
	t.Parallel()

	handler := newTestServer(t)

	rec := do(t, handler, http.MethodPost, "/api/rooms", joinOnlyHost)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("without key: got status %d, want %d", rec.Code, http.StatusUnauthorized)
	}

	req := httptest.NewRequestWithContext(
		context.Background(), http.MethodPost, "/api/rooms", bytes.NewReader([]byte(`{"name":"Test"}`)),
	)
	req.Host = joinOnlyHost
	req.Header.Set("Authorization", "Bearer "+operatorKey)

	rec = httptest.NewRecorder()

	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("with key: got status %d, want %d", rec.Code, http.StatusCreated)
	}
}

type configPayload struct {
	CreateAuthRequired bool `json:"createAuthRequired"`
	JoinOnly           bool `json:"joinOnly"`
}

func TestGetConfigPerHost(t *testing.T) {
	t.Parallel()

	handler := newTestServer(t)

	rec := do(t, handler, http.MethodGet, "/api/config", "STUBBE.DEV")
	if rec.Code != http.StatusOK {
		t.Fatalf("open host: got status %d, want %d", rec.Code, http.StatusOK)
	}

	var open configPayload

	err := json.Unmarshal(rec.Body.Bytes(), &open)
	if err != nil {
		t.Fatal(err)
	}

	if open.CreateAuthRequired || open.JoinOnly {
		t.Fatalf("open host: got createAuthRequired=%v joinOnly=%v, want false/false",
			open.CreateAuthRequired, open.JoinOnly)
	}

	rec = do(t, handler, http.MethodGet, "/api/config", joinOnlyHost)
	if rec.Code != http.StatusOK {
		t.Fatalf("join-only host: got status %d, want %d", rec.Code, http.StatusOK)
	}

	var restricted configPayload

	err = json.Unmarshal(rec.Body.Bytes(), &restricted)
	if err != nil {
		t.Fatal(err)
	}

	if !restricted.CreateAuthRequired || !restricted.JoinOnly {
		t.Fatalf("join-only host: got createAuthRequired=%v joinOnly=%v, want true/true",
			restricted.CreateAuthRequired, restricted.JoinOnly)
	}
}

func TestCreateRoomLinksFollowRequestOrigin(t *testing.T) {
	t.Parallel()

	cfg := testConfig()
	cfg.BaseURL = "https://meet.example.com"
	cfg.PublicOrigins = []string{"https://" + openHost}

	handler := routes(newTestAPI(t, cfg))

	for host, want := range map[string]string{
		openHost:                  "https://" + openHost + "/r/",
		"forged.example":          "https://meet.example.com/r/",
		strings.ToUpper(openHost): "https://" + openHost + "/r/",
	} {
		req := httptest.NewRequestWithContext(
			context.Background(), http.MethodPost, "/api/rooms", bytes.NewReader([]byte(`{"name":"Test"}`)),
		)
		req.Host = host
		req.Header.Set("Authorization", "Bearer "+operatorKey)

		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)

		var created struct {
			ShortURL string `json:"shortUrl"`
		}

		err := json.Unmarshal(rec.Body.Bytes(), &created)
		if err != nil || !strings.HasPrefix(created.ShortURL, want) {
			t.Errorf("host %s: got %q (%v), want prefix %q", host, created.ShortURL, err, want)
		}
	}
}

func createFrom(handler http.Handler, remote string, headers map[string]string) int {
	req := httptest.NewRequestWithContext(
		context.Background(), http.MethodPost, "/api/rooms", bytes.NewReader([]byte(`{"name":"Test"}`)),
	)
	req.Host = openHost
	req.RemoteAddr = remote

	for key, value := range headers {
		req.Header.Set(key, value)
	}

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	return rec.Code
}

func TestCreateRoomRateLimitsAnonymousClients(t *testing.T) {
	t.Parallel()

	handler := newTestServer(t)

	for i := range 10 {
		code := createFrom(handler, "203.0.113.7:4000", nil)
		if code != http.StatusCreated {
			t.Fatalf("creation %d: got %d", i, code)
		}
	}

	if code := createFrom(handler, "203.0.113.7:4000", nil); code != http.StatusTooManyRequests {
		t.Fatalf("11th anonymous creation: got %d, want %d", code, http.StatusTooManyRequests)
	}

	if code := createFrom(handler, "203.0.113.8:4000", nil); code != http.StatusCreated {
		t.Fatalf("another client: got %d, want %d", code, http.StatusCreated)
	}

	keyed := map[string]string{"Authorization": "Bearer " + operatorKey}
	if code := createFrom(handler, "203.0.113.7:4000", keyed); code != http.StatusCreated {
		t.Fatalf("operator key: got %d, want %d", code, http.StatusCreated)
	}
}

func TestCreateRoomRateLimitSeesThroughTrustedProxy(t *testing.T) {
	t.Parallel()

	cfg := testConfig()
	cfg.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("172.18.0.0/16")}

	handler := routes(newTestAPI(t, cfg))
	proxy := "172.18.0.4:51000"

	for i := range 10 {
		forwarded := map[string]string{forwardedFor: "198.51.100." + strconv.Itoa(i)}
		if code := createFrom(handler, proxy, forwarded); code != http.StatusCreated {
			t.Fatalf("client %d behind the proxy: got %d", i, code)
		}
	}

	spoofer := "198.51.100.200"

	for i := range 10 {
		forwarded := map[string]string{forwardedFor: "10.9.9." + strconv.Itoa(i) + ", " + spoofer}
		if code := createFrom(handler, proxy, forwarded); code != http.StatusCreated {
			t.Fatalf("spoofer attempt %d: got %d", i, code)
		}
	}

	forwarded := map[string]string{forwardedFor: "10.9.9.99, " + spoofer}
	if code := createFrom(handler, proxy, forwarded); code != http.StatusTooManyRequests {
		t.Fatalf("spoofed leftmost hop escaped the limit: got %d", code)
	}

	untrusted := map[string]string{forwardedFor: "198.51.100.77"}
	for range 10 {
		createFrom(handler, "203.0.113.50:4000", untrusted)
	}

	if code := createFrom(handler, "203.0.113.50:4000", untrusted); code != http.StatusTooManyRequests {
		t.Fatalf("untrusted peer escaped the limit via X-Forwarded-For: got %d", code)
	}
}
