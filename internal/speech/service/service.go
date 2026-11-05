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

var (
	errOddPCM         = errors.New("audio frame holds an odd number of bytes")
	errReplaced       = errors.New("replaced by a newer connection of the same member")
	errConnectionLost = errors.New("connection lost")
)

// Service serves the speech service's HTTP and WebSocket endpoints.
type Service struct {
	settings Settings
	engines  speechEngines
	sessions sync.WaitGroup
	live     liveSessions
	now      func() time.Time
}

// New builds the service and its engines from settings.
func New(settings Settings) *Service {
	var engines speechEngines = newHTTPEngines(settings)
	if settings.transcription.provider == fake {
		engines = &fakeEngines{utterances: atomic.Int64{}}
	}

	return &Service{
		settings: settings,
		engines:  engines,
		sessions: sync.WaitGroup{},
		live:     liveSessions{mu: sync.Mutex{}, sessions: map[liveKey]*liveSession{}},
		now:      time.Now,
	}
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

func (s *Service) status() wire.Status {
	named := s.settings.engines()

	engines := make(map[string]wire.EngineStatus, len(named))
	for _, entry := range named {
		engines[string(entry.purpose)] = wire.EngineStatus{
			Provider: string(entry.engine.provider),
			Model:    entry.engine.model,
			Ready:    entry.engine.ready(),
			Problem:  entry.engine.problem,
			External: entry.engine.external,
		}
	}

	all := s.settings.languages.all()

	langs := make([]wire.Language, len(all))
	for i, lang := range all {
		langs[i] = wire.Language{Code: lang.Code, Name: lang.Name}
	}

	return wire.Status{Ready: s.settings.ready(), External: s.settings.external(), Engines: engines, Languages: langs}
}

func (s *Service) stream(w http.ResponseWriter, r *http.Request) {
	claims, err := token.Verify(s.settings.secret, r.URL.Query().Get("token"), s.now())
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

	ctx, cancel := context.WithCancelCause(r.Context())
	defer cancel(nil)

	defer s.live.claim(liveKey{room: claims.Room, member: claims.Member}, func() {
		cancel(errReplaced)

		s.sessions.Go(func() { _ = conn.Close(websocket.StatusPolicyViolation, errReplaced.Error()) })
	})()

	current, err := newSession(ctx, s.settings, s.engines, claims.Member, func(ctx context.Context, message any) error {
		err := write(ctx, conn, message)
		if err != nil {
			cancel(fmt.Errorf("%w: %w", errConnectionLost, err))
		}

		return err
	})
	if err != nil {
		log.Printf("open a session: %v", err)

		_ = conn.Close(websocket.StatusInternalError, "")

		return
	}

	log.Print("session opened")

	err = s.serve(r.Context(), ctx, conn, current)
	cause := context.Cause(ctx)

	cancel(nil)
	current.close()
	closeStream(conn, err, cause)
}

func closeStream(conn *websocket.Conn, err, cause error) {
	switch {
	case errors.Is(cause, errReplaced):
		log.Print("session replaced by a newer connection")
	case errors.Is(cause, errConnectionLost):
		log.Printf("session closed: %v", cause)

		_ = conn.CloseNow()
	case cause != nil:
		log.Print("session closed: shutting down")

		_ = conn.Close(websocket.StatusGoingAway, "")
	case isClosed(err):
		log.Print("session closed")

		_ = conn.Close(websocket.StatusNormalClosure, "")
	case errors.Is(err, errForeignSpeaker):
		log.Printf("session closed: %v", err)

		_ = conn.Close(websocket.StatusPolicyViolation, errForeignSpeaker.Error())
	default:
		log.Printf("session closed: %v", err)

		_ = conn.Close(websocket.StatusInternalError, "")
	}
}

type liveKey struct {
	room   string
	member string
}

type liveSession struct {
	kick func()
}

type liveSessions struct {
	mu       sync.Mutex
	sessions map[liveKey]*liveSession
}

func (l *liveSessions) claim(key liveKey, kick func()) func() {
	claimed := &liveSession{kick: kick}

	l.mu.Lock()
	if previous, ok := l.sessions[key]; ok {
		previous.kick()
	}

	l.sessions[key] = claimed
	l.mu.Unlock()

	return func() {
		l.mu.Lock()
		defer l.mu.Unlock()

		if l.sessions[key] == claimed {
			delete(l.sessions, key)
		}
	}
}

func (s *Service) serve(readCtx, ctx context.Context, conn *websocket.Conn, current *session) error {
	for {
		kind, data, err := conn.Read(readCtx)
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
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
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
