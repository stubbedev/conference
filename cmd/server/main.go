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
	apiPrefix         = "/api/"
	signalingPath     = "/ws"
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

	hub := sfu.NewHub(sfu.HubConfig{
		Engine:         engine,
		Relay:          creds,
		MaxMembers:     cfg.MaxRoomMembers,
		MaxPublishKbps: cfg.MaxPublishKbps,
	})

	turnServer, err := relay.Start(context.Background(), creds, engine.MediaAddrs(), hub.MemberLive)
	if err != nil {
		return fmt.Errorf("relay: %w", err)
	}

	defer func() { _ = turnServer.Close() }()

	go reapLoop(database, hub, cfg.RoomTTL)

	mux, err := buildMux(database, hub, cfg)
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

	return serveUntilShutdown(srv, hub)
}

// buildMux assembles the API, signaling, and embedded UI routes.
func buildMux(database *store.Store, hub *sfu.Hub, cfg *config.Config) (*http.ServeMux, error) {
	mux := http.NewServeMux()

	apiServer := api.New(database, hub, cfg)
	apiServer.Routes(mux)

	mux.Handle("GET "+signalingPath, &ws.Handler{
		Hub:            hub,
		Store:          database,
		AllowedOrigins: cfg.AllowedOrigins,
	})

	spa, err := spaHandler(cfg.BaseURL)
	if err != nil {
		return nil, fmt.Errorf("web ui: %w", err)
	}

	mux.Handle("/", spa)

	return mux, nil
}

// serveUntilShutdown runs the HTTP server until an interrupt or a
// terminal error, then drains live rooms.
func serveUntilShutdown(srv *http.Server, hub *sfu.Hub) error {
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

	hub.CloseAll()

	return nil
}

// reapLoop periodically deletes expired session grants and, when a
// room TTL is configured, rooms older than it — skipping live rooms.
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
		log.Printf("reap: removed %d room(s) older than %s", removed, ttl)
	}
}

// spaHandler serves the embedded frontend with an index.html fallback
// for client-side routes, immutable caching for hashed assets, and
// no-cache for the app shell, whose preview-image URLs are made
// absolute against origin.
func spaHandler(origin string) (http.Handler, error) {
	dist, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		return nil, fmt.Errorf("embed: %w", err)
	}

	rawIndex, err := fs.ReadFile(dist, indexPage)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", indexPage, err)
	}

	index, err := absolutePreviewURLs(rawIndex, origin)
	if err != nil {
		return nil, err
	}

	files := http.FileServerFS(dist)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")

		_, err := fs.Stat(dist, path)
		if path == "" || path == indexPage || err != nil {
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeContent(w, r, indexPage, time.Time{}, bytes.NewReader(index))

			return
		}

		if strings.HasPrefix(path, assetsDir) {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}

		files.ServeHTTP(w, r)
	}), nil
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, apiPrefix) || r.URL.Path == signalingPath {
			start := time.Now()

			next.ServeHTTP(w, r)

			//nolint:gosec // %q quotes the path, so control characters cannot forge log lines.
			log.Printf("%s %q %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))

			return
		}

		next.ServeHTTP(w, r)
	})
}
