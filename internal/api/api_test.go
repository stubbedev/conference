package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/stubbe/conference/internal/api"
	"github.com/stubbe/conference/internal/config"
	"github.com/stubbe/conference/internal/sfu"
	"github.com/stubbe/conference/internal/store"
)

const (
	openHost     = "stubbe.dev"
	joinOnlyHost = "mariabugge.com"
	operatorKey  = "s3cret"
)

func newTestServer(t *testing.T) http.Handler {
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

	cfg := &config.Config{
		HTTPAddr:        "",
		BaseURL:         "",
		DBPath:          "",
		APIKeys:         []string{operatorKey},
		JoinOnly:        true,
		OpenCreateHosts: []string{openHost},
		ICEUDPPort:      0,
		ExternalIPs:     nil,
		ICEServers:      nil,
		MaxPublishKbps:  0,
		AllowedOrigins:  nil,
		SessionTTL:      365 * 24 * time.Hour,
		MaxRoomMembers:  0,
		RoomTTL:         0,
	}

	hub := sfu.NewHub(sfu.HubConfig{
		Engine:         engine,
		MaxMembers:     0,
		MaxPublishKbps: 0,
	})

	server := api.New(storage, hub, cfg)

	mux := http.NewServeMux()
	server.Routes(mux)

	return mux
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
