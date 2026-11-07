// Command conference is the single self-contained server: REST API,
// signaling WebSocket, embedded web UI, and the WebRTC SFU.
package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/stubbe/conference/internal/api"
	"github.com/stubbe/conference/internal/config"
	"github.com/stubbe/conference/internal/relay"
	"github.com/stubbe/conference/internal/sfu"
	"github.com/stubbe/conference/internal/speech/service"
	"github.com/stubbe/conference/internal/store"
	"github.com/stubbe/conference/internal/ws"
	web "github.com/stubbe/conference/web"
)

const (
	headerReadTimeout = 10 * time.Second
	shutdownTimeout   = 5 * time.Second
	reapInterval      = time.Hour
	reapTimeout       = 30 * time.Second
	indexPage         = "index.html"
	assetsDir         = "assets/"
	// The blur model and its runtime never change under the same path, and
	// they are megabytes: a browser that has them should keep them.
	visionDir     = "vision/"
	apiPrefix     = "/api/"
	signalingPath = "/ws"
	speechPath    = "/ws/speech"
)

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)

	err := run()
	if err != nil {
		log.Fatal(err)
	}
}

// run wires every subsystem together and serves until shutdown.
func run() error {
	cfg, err := config.FromEnv()
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}

	database, err := store.Open(cfg.DBPath)
	if err != nil {
		return fmt.Errorf("store: %w", err)
	}

	defer func() { _ = database.Close() }()

	engine, closeEngine, err := sfu.NewEngine(cfg.ICEUDPPort, cfg.ExternalIPs)
	if err != nil {
		return fmt.Errorf("sfu engine: %w", err)
	}

	defer closeEngine()

	creds, err := relay.NewCredentials(cfg.Relay)
	if err != nil {
		return fmt.Errorf("relay: %w", err)
	}

	speech, err := newLiveTranslation(cfg)
	if err != nil {
		return err
	}

	hub := newHub(cfg, engine, creds, speech)

	turnServer, err := relay.Start(context.Background(), creds, engine.MediaAddrs(), hub.MemberLive)
	if err != nil {
		return fmt.Errorf("relay: %w", err)
	}

	defer func() { _ = turnServer.Close() }()

	go reapLoop(database, hub, cfg.RoomTTL)

	mux, err := buildMux(database, hub, cfg, speech)
	if err != nil {
		return err
	}

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           logRequests(mux),
		ReadHeaderTimeout: headerReadTimeout,
	}

	log.Printf("conference listening on %s (db: %s, ice udp: %d, turn udp+tcp: %d, turns host: %q)",
		cfg.HTTPAddr, cfg.DBPath, cfg.ICEUDPPort, cfg.Relay.Port, cfg.Relay.TLSHost)

	return serveUntilShutdown(srv, hub, speech)
}

// liveTranslation is what the server runs for live translation: its
// speech service when the server runs the engines, and the model files
// the browsers load when they run them instead.
type liveTranslation struct {
	status  service.Status
	streams *service.Service // nil: the browsers transcribe on their own
	models  http.Handler     // nil unless the browsers load models from here
}

// newLiveTranslation builds live translation from the environment, with
// the status the web app shows for it.
func newLiveTranslation(cfg *config.Config) (liveTranslation, error) {
	settings, err := service.FromEnv(os.Getenv)
	if err != nil {
		return liveTranslation{}, fmt.Errorf("speech: %w", err)
	}

	settings.LogEngines()

	streams, models := service.Start(settings, func(r *http.Request) []string {
		return ws.OriginPatterns(cfg.AllowedOrigins, r)
	})

	return liveTranslation{status: settings.Status(), streams: streams, models: models}, nil
}

// tokens is the speech service the SFU streams to, nil when the browsers
// run the engines. A nil service typed as the interface would not read as
// nil, so the caller checks the service itself.
func (l liveTranslation) tokens() *service.Service {
	return l.streams
}

// newHub creates the SFU hub, with live translation when it can run.
func newHub(cfg *config.Config, engine *sfu.Engine, creds *relay.Credentials, translation liveTranslation) *sfu.Hub {
	hub := sfu.HubConfig{
		Engine:         engine,
		Relay:          creds,
		MaxMembers:     cfg.MaxRoomMembers,
		MaxPublishKbps: cfg.MaxPublishKbps,
		Speech:         nil,
		Translate:      translation.status.Available,
	}

	if streams := translation.tokens(); streams != nil {
		hub.Speech = streams
	}

	return sfu.NewHub(hub)
}

// buildMux assembles the API, signaling, speech, and embedded UI routes.
func buildMux(database *store.Store, hub *sfu.Hub, cfg *config.Config, translation liveTranslation) (*http.ServeMux, error) {
	mux := http.NewServeMux()

	api.New(database, hub, cfg, translation.status).Routes(mux)

	mux.Handle("GET "+signalingPath, &ws.Handler{
		Hub:            hub,
		Store:          database,
		AllowedOrigins: cfg.AllowedOrigins,
	})

	if translation.streams != nil {
		mux.Handle("GET "+speechPath, translation.streams)
	}

	if translation.models != nil {
		mux.Handle("GET "+service.ModelsPath, translation.models)
	}

	dist, err := fs.Sub(web.Dist, "dist/app")
	if err != nil {
		return nil, fmt.Errorf("embed: %w", err)
	}

	frontend, err := newWebUI(cfg, dist)
	if err != nil {
		return nil, fmt.Errorf("web ui: %w", err)
	}

	frontend.routes(mux)

	return mux, nil
}

// serveUntilShutdown runs the HTTP server until an interrupt or a
// terminal error, then ends the speech streams and drains live rooms.
func serveUntilShutdown(srv *http.Server, hub *sfu.Hub, translation liveTranslation) error {
	serverErr := make(chan error, 1)

	go func() {
		serverErr <- srv.ListenAndServe()
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-serverErr:
		if !errors.Is(err, http.ErrServerClosed) {
			return fmt.Errorf("http: %w", err)
		}
	case <-stop:
		log.Printf("shutting down")
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	err := srv.Shutdown(shutdownCtx)
	if err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}

	if translation.streams != nil {
		translation.streams.Shutdown()
	}

	hub.CloseAll()

	return nil
}

// reapLoop periodically deletes expired session grants and, when a
// room TTL is configured, rooms nobody has joined for longer than it —
// skipping live rooms.
func reapLoop(database *store.Store, hub *sfu.Hub, ttl time.Duration) {
	reapOnce(database, hub, ttl)

	ticker := time.NewTicker(reapInterval)
	defer ticker.Stop()

	for range ticker.C {
		reapOnce(database, hub, ttl)
	}
}

// reapOnce removes stale, not-currently-live rooms and their sessions.
func reapOnce(database *store.Store, hub *sfu.Hub, ttl time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), reapTimeout)
	defer cancel()

	err := database.PurgeExpiredSessions(ctx)
	if err != nil {
		log.Printf("reap: %v", err)
	}

	if ttl <= 0 {
		return
	}

	slugs, err := database.StaleRooms(ctx, time.Now().Add(-ttl))
	if err != nil {
		log.Printf("reap: %v", err)

		return
	}

	removed := 0

	for _, slug := range slugs {
		if hub.LiveCount(slug) > 0 {
			continue
		}

		err = database.DeleteRoom(ctx, slug)
		if err != nil {
			log.Printf("reap: %s: %v", slug, err)

			continue
		}

		removed++
	}

	if removed > 0 {
		log.Printf("reap: removed %d room(s) unused for %s", removed, ttl)
	}
}

// webUI serves the embedded frontend: the app page for client-side
// routes, with preview URLs on the request's origin, and the built
// files with immutable caching for hashed assets.
type webUI struct {
	cfg   *config.Config
	dist  fs.FS
	files http.Handler
	pages map[string][]byte
}

func newWebUI(cfg *config.Config, dist fs.FS) (*webUI, error) {
	rawIndex, err := fs.ReadFile(dist, indexPage)
	if err != nil {
		return nil, fmt.Errorf("read %s (build the web UI first): %w", indexPage, err)
	}

	pages := map[string][]byte{}

	for _, origin := range append(cfg.Origins(), cfg.BaseURL) {
		pages[origin], err = absolutePreviewURLs(rawIndex, origin)
		if err != nil {
			return nil, fmt.Errorf("index for %q: %w", origin, err)
		}
	}

	return &webUI{cfg: cfg, dist: dist, files: http.FileServerFS(dist), pages: pages}, nil
}

func (ui *webUI) routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /{$}", ui.serveApp)
	mux.HandleFunc("GET /r/{slug}", ui.serveApp)
	mux.HandleFunc("/", ui.serveFile)
}

func (ui *webUI) serveApp(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, indexPage, time.Time{}, bytes.NewReader(ui.pages[ui.cfg.OriginFor(r.Host)]))
}

func (ui *webUI) serveFile(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)

		return
	}

	path := strings.TrimPrefix(r.URL.Path, "/")

	info, err := fs.Stat(ui.dist, path)
	if err != nil || info.IsDir() {
		http.NotFound(w, r)

		return
	}

	if strings.HasPrefix(path, assetsDir) || strings.HasPrefix(path, visionDir) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}

	ui.files.ServeHTTP(w, r)
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, apiPrefix) || r.URL.Path == signalingPath || r.URL.Path == speechPath {
			start := time.Now()

			next.ServeHTTP(w, r)

			//nolint:gosec // %q quotes the path, so control characters cannot forge log lines.
			log.Printf("%s %q %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))

			return
		}

		next.ServeHTTP(w, r)
	})
}
