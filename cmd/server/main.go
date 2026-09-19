// Command conference is the single self-contained server: REST API,
// signaling WebSocket, embedded web UI, and the WebRTC SFU.
package main

import (
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
	"github.com/stubbe/conference/internal/sfu"
	"github.com/stubbe/conference/internal/store"
	"github.com/stubbe/conference/internal/ws"
	web "github.com/stubbe/conference/web"
)

const (
	headerReadTimeout = 10 * time.Second
	shutdownTimeout   = 5 * time.Second
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

	hub := sfu.NewHub(sfu.HubConfig{
		Engine:         engine,
		MaxMembers:     cfg.MaxRoomMembers,
		MaxPublishKbps: cfg.MaxPublishKbps,
	})

	mux := buildMux(database, hub, cfg)

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           logRequests(mux),
		ReadHeaderTimeout: headerReadTimeout,
	}

	log.Printf("conference listening on %s (db: %s, ice udp: %d)", cfg.HTTPAddr, cfg.DBPath, cfg.ICEUDPPort)

	return serveUntilShutdown(srv, hub)
}

// buildMux assembles the API, signaling, and embedded UI routes.
func buildMux(database *store.Store, hub *sfu.Hub, cfg *config.Config) *http.ServeMux {
	mux := http.NewServeMux()

	apiServer := api.New(database, hub, cfg)
	apiServer.Routes(mux)

	mux.Handle("GET "+signalingPath, &ws.Handler{
		Hub:            hub,
		Store:          database,
		AllowedOrigins: cfg.AllowedOrigins,
	})
	mux.Handle("/", spaHandler())

	return mux
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

// spaHandler serves the embedded frontend with an index.html fallback
// for client-side routes, immutable caching for hashed assets, and
// no-cache for the app shell.
func spaHandler() http.Handler {
	dist, err := fs.Sub(web.Dist, "dist")
	if err != nil {
		log.Fatalf("embed: %v", err)
	}

	files := http.FileServerFS(dist)

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			path = indexPage
		}

		_, err := fs.Stat(dist, path)
		if err != nil {
			r.URL.Path = "/" // unknown path: serve the app shell

			path = indexPage
		}

		switch {
		case path == indexPage:
			w.Header().Set("Cache-Control", "no-cache")
		case strings.HasPrefix(path, assetsDir):
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}

		files.ServeHTTP(w, r)
	})
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
