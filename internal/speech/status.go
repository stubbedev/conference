// Package speech asks the speech service whether live translation can
// run: whether its engines are set up, whether any sends data off its
// network, and which languages it speaks.
package speech

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	fetchTimeout = 3 * time.Second
	// A ready service is asked again after readyTTL; a not-ready or
	// unreachable one sooner, so fixing it shows up quickly.
	readyTTL    = time.Minute
	notReadyTTL = 15 * time.Second
)

// Reasons the web app shows next to the disabled live-translation controls.
const (
	ReasonNotConfigured = "Live translation needs a speech service: set SPEECH_URL and SPEECH_SECRET on the meeting server."
	ReasonUnreachable   = "Live translation needs the speech service, which cannot be reached right now."
)

var (
	errUnsupportedScheme = errors.New("speech: SPEECH_URL must start with ws:// or wss://")
	errStatusCode        = errors.New("speech: unexpected status code")
)

// Language is one language the speech service speaks.
type Language struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

// Status is what the web app needs to know about live translation.
type Status struct {
	Available bool       `json:"available"`
	Reason    string     `json:"reason,omitempty"`
	Languages []Language `json:"languages"`
	External  bool       `json:"external"`
}

type engineStatus struct {
	Ready   bool   `json:"ready"`
	Problem string `json:"problem"`
}

type serviceStatus struct {
	Ready     bool                    `json:"ready"`
	External  bool                    `json:"external"`
	Engines   map[string]engineStatus `json:"engines"`
	Languages []Language              `json:"languages"`
}

// Checker fetches and caches the speech service's status.
type Checker struct {
	statusURL string
	client    *http.Client
	now       func() time.Time

	mu      sync.Mutex
	cached  Status
	expires time.Time
}

// StatusURL derives the status endpoint from the stream URL, e.g.
// wss://speech.example/v1/stream → https://speech.example/v1/status.
func StatusURL(streamURL string) (string, error) {
	parsed, err := url.Parse(streamURL)
	if err != nil {
		return "", fmt.Errorf("speech: parse SPEECH_URL: %w", err)
	}

	switch parsed.Scheme {
	case "ws":
		parsed.Scheme = "http"
	case "wss":
		parsed.Scheme = "https"
	default:
		return "", errUnsupportedScheme
	}

	parsed.Path = strings.TrimSuffix(strings.TrimSuffix(parsed.Path, "/"), "/stream") + "/status"
	parsed.RawQuery = ""

	return parsed.String(), nil
}

// NewChecker checks the speech service behind streamURL, or at
// statusURL when that is set.
func NewChecker(streamURL, statusURL string, client *http.Client) (*Checker, error) {
	if statusURL == "" {
		derived, err := StatusURL(streamURL)
		if err != nil {
			return nil, err
		}

		statusURL = derived
	}

	return &Checker{
		statusURL: statusURL,
		client:    client,
		now:       time.Now,
		mu:        sync.Mutex{},
		cached:    Status{Available: false, Reason: "", Languages: nil, External: false},
		expires:   time.Time{},
	}, nil
}

// Status reports whether live translation can run. A nil Checker means
// no speech service is configured.
func (c *Checker) Status(ctx context.Context) Status {
	if c == nil {
		return Status{Available: false, Reason: ReasonNotConfigured, Languages: []Language{}, External: false}
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if c.now().Before(c.expires) {
		return c.cached
	}

	c.cached = c.fetch(ctx)

	ttl := notReadyTTL
	if c.cached.Available {
		ttl = readyTTL
	}

	c.expires = c.now().Add(ttl)

	return c.cached
}

// Ready reports whether live translation can run right now.
func (c *Checker) Ready() bool {
	return c.Status(context.Background()).Available
}

func (c *Checker) fetch(ctx context.Context) Status {
	unreachable := Status{Available: false, Reason: ReasonUnreachable, Languages: []Language{}, External: false}

	ctx, cancel := context.WithTimeout(ctx, fetchTimeout)
	defer cancel()

	service, err := c.get(ctx)
	if err != nil {
		return unreachable
	}

	languages := service.Languages
	if languages == nil {
		languages = []Language{}
	}

	return Status{
		Available: service.Ready,
		Reason:    notReadyReason(service),
		Languages: languages,
		External:  service.External,
	}
}

func (c *Checker) get(ctx context.Context) (serviceStatus, error) {
	var service serviceStatus

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.statusURL, http.NoBody)
	if err != nil {
		return service, fmt.Errorf("speech: status request: %w", err)
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return service, fmt.Errorf("speech: status: %w", err)
	}

	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return service, fmt.Errorf("%w: %d", errStatusCode, resp.StatusCode)
	}

	err = json.NewDecoder(resp.Body).Decode(&service)
	if err != nil {
		return service, fmt.Errorf("speech: decode status: %w", err)
	}

	return service, nil
}

// notReadyReason names what the speech service still needs, e.g. "Live
// translation needs a translation model to be set up on the speech
// service: set TRANSLATE_MODEL to the Ollama model to translate with."
func notReadyReason(service serviceStatus) string {
	if service.Ready {
		return ""
	}

	var purposes, problems []string

	for _, purpose := range []string{"transcription", "translation", "voice"} {
		engine, ok := service.Engines[purpose]
		if !ok || engine.Ready {
			continue
		}

		purposes = append(purposes, purpose)

		if engine.Problem != "" {
			problems = append(problems, engine.Problem)
		}
	}

	if len(purposes) == 0 {
		return "Live translation is not set up on the speech service."
	}

	reason := "Live translation needs a " + strings.Join(purposes, " and ") + " model to be set up on the speech service"
	if len(problems) > 0 {
		reason += ": " + strings.Join(problems, "; ")
	}

	return reason + "."
}
