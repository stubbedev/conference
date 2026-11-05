package service

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/stubbe/conference/internal/speech/token"
	"github.com/stubbe/conference/internal/speech/wire"
)

const (
	readLimit = 1 << 16
	pcmWidth  = 2
)

type engineStatus struct {
	Provider provider `json:"provider"`
	Model    string   `json:"model"`
	Ready    bool     `json:"ready"`
	Problem  string   `json:"problem"`
	External bool     `json:"external"`
}

type languageStatus struct {
	Code string `json:"code"`
	Name string `json:"name"`
}

type status struct {
	Ready     bool                     `json:"ready"`
	External  bool                     `json:"external"`
	Engines   map[purpose]engineStatus `json:"engines"`
	Languages []languageStatus         `json:"languages"`
}

var errOddPCM = errors.New("audio frame holds an odd number of bytes")

// Service serves the speech service's HTTP and WebSocket endpoints.
type Service struct {
	settings Settings
	engines  speechEngines
	sessions sync.WaitGroup
	now      func() time.Time
}

// New builds the service and its engines from settings.
func New(settings Settings) *Service {
	var engines speechEngines = newHTTPEngines(settings)
	if settings.transcription.provider == fake {
		engines = &fakeEngines{utterances: atomic.Int64{}}
	}

	return &Service{settings: settings, engines: engines, sessions: sync.WaitGroup{}, now: time.Now}
}

// Handler routes /healthz, /v1/status and /v1/stream.
func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /v1/status", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, s.status())
	})
	mux.HandleFunc("GET /v1/stream", s.stream)

	return mux
}

// Wait blocks until every stream has ended.
func (s *Service) Wait() {
	s.sessions.Wait()
}

func (s *Service) status() status {
	named := s.settings.engines()

	engines := make(map[purpose]engineStatus, len(named))
	for _, entry := range named {
		engines[entry.purpose] = engineStatus{
			Provider: entry.engine.provider,
			Model:    entry.engine.model,
			Ready:    entry.engine.ready(),
			Problem:  entry.engine.problem,
			External: entry.engine.external,
		}
	}

	all := s.settings.languages.all()

	langs := make([]languageStatus, len(all))
	for i, lang := range all {
		langs[i] = languageStatus{Code: lang.Code, Name: lang.Name}
	}

	return status{Ready: s.settings.ready(), External: s.settings.external(), Engines: engines, Languages: langs}
}

func (s *Service) stream(w http.ResponseWriter, r *http.Request) {
	_, err := token.Verify(s.settings.secret, r.URL.Query().Get("token"), s.now())
	if err != nil {
		http.Error(w, "invalid or expired token", http.StatusForbidden)

		return
	}

	if !s.settings.ready() {
		http.Error(w, "live translation is not set up", http.StatusServiceUnavailable)

		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: []string{"*"}})
	if err != nil {
		log.Printf("accept the stream: %v", err)

		return
	}

	conn.SetReadLimit(readLimit)

	s.sessions.Add(1)
	defer s.sessions.Done()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	current := newSession(s.settings, s.engines, func(ctx context.Context, message any) error {
		return write(ctx, conn, message)
	})

	log.Print("session opened")

	err = s.serve(ctx, conn, current)

	cancel()
	current.close()

	if ctx.Err() == nil && !isClosed(err) {
		log.Printf("session closed: %v", err)

		_ = conn.Close(websocket.StatusInternalError, "")

		return
	}

	log.Print("session closed")

	_ = conn.Close(websocket.StatusNormalClosure, "")
}

func (s *Service) serve(ctx context.Context, conn *websocket.Conn, current *session) error {
	for {
		kind, data, err := conn.Read(ctx)
		if err != nil {
			return fmt.Errorf("read: %w", err)
		}

		if kind == websocket.MessageBinary {
			err = audio(ctx, current, data)
		} else {
			err = handle(ctx, conn, current, data)
		}

		if err != nil {
			return err
		}
	}
}

func audio(ctx context.Context, current *session, data []byte) error {
	var header wire.AudioHeader

	raw, err := wire.Unpack(data, &header)
	if err != nil {
		return fmt.Errorf("audio frame: %w", err)
	}

	if len(raw)%pcmWidth != 0 {
		return errOddPCM
	}

	pcm := make([]int16, len(raw)/pcmWidth)

	_, err = binary.Decode(raw, binary.LittleEndian, pcm)
	if err != nil {
		return fmt.Errorf("audio frame: %w", err)
	}

	return current.audio(ctx, header, pcm)
}

func handle(ctx context.Context, conn *websocket.Conn, current *session, data []byte) error {
	var message wire.Command

	err := json.Unmarshal(data, &message)
	if err != nil {
		return fmt.Errorf("parse a command: %w", err)
	}

	switch message.Type {
	case wire.TypeHello:
		log.Printf("targets: %s", strings.Join(current.setTargets(message.Targets), ","))

		return write(ctx, conn, wire.Command{Type: wire.TypeReady, Targets: nil, Speaker: ""})
	case wire.TypeEnd:
		return current.end(ctx, message.Speaker)
	default:
		return nil
	}
}

func write(ctx context.Context, conn *websocket.Conn, message any) error {
	kind := websocket.MessageText

	var (
		data []byte
		err  error
	)

	if frame, ok := message.(voiceFrame); ok {
		kind = websocket.MessageBinary
		data, err = wire.Pack(frame.header, frame.pcm)
	} else {
		data, err = json.Marshal(message)
	}

	if err != nil {
		return fmt.Errorf("encode a message: %w", err)
	}

	err = conn.Write(ctx, kind, data)
	if err != nil {
		return fmt.Errorf("write a message: %w", err)
	}

	return nil
}

func isClosed(err error) bool {
	if errors.Is(err, io.EOF) {
		return true
	}

	code := websocket.CloseStatus(err)

	return code == websocket.StatusNormalClosure || code == websocket.StatusGoingAway || code == websocket.StatusNoStatusRcvd
}

func writeJSON(w http.ResponseWriter, body any) {
	w.Header().Set("Content-Type", "application/json")

	err := json.NewEncoder(w).Encode(body)
	if err != nil {
		log.Printf("write a reply: %v", err)
	}
}
