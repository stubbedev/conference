package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	huggingFace = "https://huggingface.co"

	hubConnectTimeout = 10 * time.Second
	hubHeaderTimeout  = 30 * time.Second
	hubStallTimeout   = 30 * time.Second

	hubAttempts       = 4
	defaultRetryAfter = 60 * time.Second
	maxRetryAfter     = 330 * time.Second
)

var (
	errHubStatus  = errors.New("the hub answered")
	errHubLength  = errors.New("the hub announced a length other than the manifest's")
	errHubStalled = errors.New("the hub sent nothing")
)

// hub fetches model files from a Hugging Face Hub, following its
// redirects to wherever it stores the bytes.
type hub struct {
	base   *url.URL
	client *http.Client
	stall  time.Duration
}

func newHub(base *url.URL) hub {
	var dialer net.Dialer

	dialer.Timeout = hubConnectTimeout

	transport, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		panic("net/http's default transport is not an *http.Transport")
	}

	transport = transport.Clone()
	transport.DialContext = dialer.DialContext
	transport.ResponseHeaderTimeout = hubHeaderTimeout

	return hub{base: base, client: &http.Client{Transport: transport}, stall: hubStallTimeout}
}

func (h hub) url(file hubFile) string {
	return h.base.JoinPath(file.repo, "resolve", file.revision, file.name).String()
}

// open starts fetching file, waiting out a rate limit as long as the hub
// asks within bounds, and returns its body, which fails once the hub
// stalls. The hub's answer must be the file whole, in the size the
// manifest gives.
func (h hub) open(ctx context.Context, file hubFile) (io.ReadCloser, error) {
	address := h.url(file)
	ctx, cancel := context.WithCancelCause(ctx)

	response, err := h.get(ctx, address)
	if err != nil {
		cancel(nil)

		return nil, err
	}

	if response.ContentLength >= 0 && response.ContentLength != file.size {
		cancel(nil)

		_ = response.Body.Close()

		return nil, fmt.Errorf("%w for %s: %d bytes, want %d", errHubLength, address, response.ContentLength, file.size)
	}

	return newStallReader(ctx, cancel, response.Body, h.stall, address), nil
}

func (h hub) get(ctx context.Context, address string) (*http.Response, error) {
	for attempt := 1; ; attempt++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
		if err != nil {
			return nil, fmt.Errorf("request %s: %w", address, err)
		}

		response, err := h.client.Do(request)
		if err != nil {
			return nil, fmt.Errorf("fetch %s: %w", address, err)
		}

		if response.StatusCode == http.StatusOK {
			return response, nil
		}

		_ = response.Body.Close()

		if response.StatusCode != http.StatusTooManyRequests || attempt == hubAttempts {
			return nil, fmt.Errorf("%w %s for %s", errHubStatus, response.Status, address)
		}

		wait := retryAfter(response.Header.Get("Retry-After"))
		log.Printf("%s is rate limited; waiting %s before attempt %d of %d", address, wait, attempt+1, hubAttempts)

		err = sleepContext(ctx, wait)
		if err != nil {
			return nil, fmt.Errorf("wait to fetch %s: %w", address, err)
		}
	}
}

// retryAfter is how long the hub asks to wait before the next attempt,
// in whole seconds, within bounds; a date or nothing waits the default.
func retryAfter(header string) time.Duration {
	seconds, err := strconv.Atoi(strings.TrimSpace(header))
	if err != nil || seconds <= 0 {
		return defaultRetryAfter
	}

	return min(time.Duration(seconds)*time.Second, maxRetryAfter)
}

func sleepContext(ctx context.Context, wait time.Duration) error {
	timer := time.NewTimer(wait)
	defer timer.Stop()

	select {
	case <-timer.C:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("waiting %s: %w", wait, context.Cause(ctx))
	}
}

// stallReader fails a body that sends nothing for longer than stall.
type stallReader struct {
	ctx     context.Context //nolint:containedctx // The body lives as long as its request's context.
	cancel  context.CancelCauseFunc
	body    io.ReadCloser
	timer   *time.Timer
	stall   time.Duration
	address string
}

func newStallReader(
	ctx context.Context, cancel context.CancelCauseFunc, body io.ReadCloser, stall time.Duration, address string,
) *stallReader {
	timer := time.AfterFunc(stall, func() { cancel(errHubStalled) })

	return &stallReader{ctx: ctx, cancel: cancel, body: body, timer: timer, stall: stall, address: address}
}

func (s *stallReader) Read(into []byte) (int, error) {
	read, err := s.body.Read(into)
	s.timer.Reset(s.stall)

	if err == nil || errors.Is(err, io.EOF) {
		return read, err //nolint:wrapcheck // io.EOF must stay io.EOF for io.Reader's callers.
	}

	cause := context.Cause(s.ctx)
	if errors.Is(cause, errHubStalled) {
		return read, fmt.Errorf("read %s: %w for %s", s.address, cause, s.stall)
	}

	return read, fmt.Errorf("read %s: %w", s.address, err)
}

func (s *stallReader) Close() error {
	s.timer.Stop()
	s.cancel(nil)

	err := s.body.Close()
	if err != nil {
		return fmt.Errorf("close %s: %w", s.address, err)
	}

	return nil
}
