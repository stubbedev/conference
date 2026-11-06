package service

import (
	"context"
	"crypto/rand"
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
	tokenTTL  = time.Hour
)

var (
	errOddPCM         = errors.New("audio frame holds an odd number of bytes")
	errReplaced       = errors.New("replaced by a newer connection of the same member")
	errConnectionLost = errors.New("connection lost")
	errShuttingDown   = errors.New("shutting down")
)

// Service streams each speaking member's audio to the engines and back.
// It signs the tokens that admit a member with a key of its own, made
// fresh for every process.
type Service struct {
	settings       Settings
	engines        speechEngines
	key            []byte
	originPatterns func(*http.Request) []string
	sessions       sync.WaitGroup
	live           liveSessions
	now            func() time.Time
}

// New builds the service and its engines from settings. originPatterns
// names the origins a stream may be opened from.
func New(settings Settings, originPatterns func(*http.Request) []string) *Service {
	var engines speechEngines = newHTTPEngines(settings)
	if settings.transcription.provider == fake {
		engines = &fakeEngines{utterances: atomic.Int64{}}
	}

	return &Service{
		settings:       settings,
		engines:        engines,
		key:            []byte(rand.Text()),
		originPatterns: originPatterns,
		sessions:       sync.WaitGroup{},
		live:           liveSessions{mu: sync.Mutex{}, sessions: map[liveKey]*liveSession{}, closed: false},
		now:            time.Now,
	}
}

// Token admits member of room to a stream for the next hour.
func (s *Service) Token(room, member string) (string, error) {
	minted, err := token.Mint(s.key, token.Claims{Room: room, Member: member, Exp: s.now().Add(tokenTTL).Unix()})
	if err != nil {
		return "", fmt.Errorf("speech token for %s in %s: %w", member, room, err)
	}

	return minted, nil
}

// Shutdown ends every stream, refuses new ones and waits until they have closed.
func (s *Service) Shutdown() {
	s.live.close()
	s.sessions.Wait()
}

// ServeHTTP upgrades a member's request, admitted by its token, to a stream.
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	claims, err := token.Verify(s.key, r.URL.Query().Get("token"), s.now())
	if err != nil {
		http.Error(w, "invalid or expired token", http.StatusForbidden)

		return
	}

	if !s.settings.ready() {
		http.Error(w, "live translation is not set up", http.StatusServiceUnavailable)

		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{OriginPatterns: s.originPatterns(r)})
	if err != nil {
		log.Printf("accept the stream: %v", err)

		return
	}

	conn.SetReadLimit(readLimit)

	s.sessions.Add(1)
	defer s.sessions.Done()

	ctx, cancel := context.WithCancelCause(r.Context())
	defer cancel(nil)

	defer s.live.claim(liveKey{room: claims.Room, member: claims.Member}, func(cause error) {
		cancel(cause)

		s.sessions.Go(func() { _ = conn.Close(kickStatus(cause), cause.Error()) })
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
	case errors.Is(cause, errReplaced), errors.Is(cause, errShuttingDown):
		log.Printf("session closed: %v", cause)
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

// kickStatus is the close status of a stream ended for cause: a policy
// violation for a replaced one, going away when the service shuts down.
func kickStatus(cause error) websocket.StatusCode {
	if errors.Is(cause, errReplaced) {
		return websocket.StatusPolicyViolation
	}

	return websocket.StatusGoingAway
}

type liveSession struct {
	kick func(cause error)
}

type liveSessions struct {
	mu       sync.Mutex
	sessions map[liveKey]*liveSession
	closed   bool
}

// claim makes kick's stream the member's only one, ending the one it
// replaces; once the service is closed, it ends kick's at once. The
// returned func gives the claim up.
func (l *liveSessions) claim(key liveKey, kick func(cause error)) func() {
	claimed := &liveSession{kick: kick}

	l.mu.Lock()
	defer l.mu.Unlock()

	if l.closed {
		kick(errShuttingDown)

		return func() {}
	}

	if previous, ok := l.sessions[key]; ok {
		previous.kick(errReplaced)
	}

	l.sessions[key] = claimed

	return func() {
		l.mu.Lock()
		defer l.mu.Unlock()

		if l.sessions[key] == claimed {
			delete(l.sessions, key)
		}
	}
}

// close ends every stream and refuses later claims.
func (l *liveSessions) close() {
	l.mu.Lock()
	defer l.mu.Unlock()

	l.closed = true

	for _, session := range l.sessions {
		session.kick(errShuttingDown)
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

	if header.Sample {
		return current.sampleAudio(header, pcm)
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
		current.setVoiceTargets(message.VoiceTargets)

		return write(ctx, conn, wire.Command{Type: wire.TypeReady, Targets: nil, VoiceTargets: nil, Speaker: "", Lang: ""})
	case wire.TypeEnd:
		return current.end(ctx, message.Speaker)
	case wire.TypeVoiceSample:
		return current.finishSample(ctx, message.Speaker, message.Lang)
	case wire.TypeForgetVoice:
		return current.forgetVoice(message.Speaker)
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
