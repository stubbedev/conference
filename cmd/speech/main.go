// Command speech is the speech service behind live translation.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/stubbe/conference/internal/speech/service"
)

const (
	headerReadTimeout = 10 * time.Second
	shutdownTimeout   = 5 * time.Second
)

func main() {
	log.SetFlags(log.LstdFlags | log.LUTC)

	err := run()
	if err != nil {
		log.Fatal(err)
	}
}

func run() error {
	settings, err := service.FromEnv(os.Getenv)
	if err != nil {
		return fmt.Errorf("config: %w", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	speech := service.New(settings)
	server := &http.Server{
		Addr:              settings.Addr,
		Handler:           speech.Handler(),
		ReadHeaderTimeout: headerReadTimeout,
		BaseContext:       func(net.Listener) context.Context { return ctx },
	}

	settings.LogEngines()

	serveErr := make(chan error, 1)

	go func() {
		serveErr <- server.ListenAndServe()
	}()

	log.Printf("speech service on %s", settings.Addr)

	select {
	case err = <-serveErr:
		return fmt.Errorf("serve: %w", err)
	case <-ctx.Done():
	}

	shutdownCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), shutdownTimeout)
	defer cancel()

	err = server.Shutdown(shutdownCtx)

	speech.Wait()

	if err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("shutdown: %w", err)
	}

	return nil
}
