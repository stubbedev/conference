// Package ws implements the signaling WebSocket: one connection per
// member, JSON frames (see the sfu.Message shape), validated against the
// persisted room and session before the hub admits the member.
package ws

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/stubbe/conference/internal/sfu"
	"github.com/stubbe/conference/internal/store"
)

const (
	joinTimeout   = 15 * time.Second
	pingInterval  = 25 * time.Second
	frameTimeout  = 10 * time.Second
	maxMemberName = 60
	maxFrameBytes = 256 << 10
	outQueueDepth = 128
)

// Handler upgrades and serves signaling connections.
type Handler struct {
	Hub   *sfu.Hub
	Store *store.Store

	// AllowedOrigins, when non-empty, replaces the same-origin check.
	AllowedOrigins []string
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: h.originPatterns(r),
	})
	if err != nil {
		return
	}

	defer func() { _ = conn.Close(websocket.StatusInternalError, "") }()

	conn.SetReadLimit(maxFrameBytes)

	// The session outlives the request: the request context is canceled
	// as soon as the connection is hijacked.
	ctx := context.WithoutCancel(r.Context())

	member, out, done, teardown := h.admit(ctx, conn)
	if member == nil {
		return
	}

	go h.writePump(ctx, conn, out, done, teardown)

	h.readPump(ctx, conn, member, teardown)
}

// originPatterns converts the origin policy into websocket.Accept host
// patterns for this request.
func (h *Handler) originPatterns(r *http.Request) []string {
	if len(h.AllowedOrigins) > 0 {
		patterns := make([]string, 0, len(h.AllowedOrigins))

		for _, origin := range h.AllowedOrigins {
			parsed, err := url.Parse(origin)
			if err == nil && parsed.Host != "" {
				patterns = append(patterns, parsed.Host)
			}
		}

		return patterns
	}

	return []string{r.Host} // same-origin only
}

// admit performs the join handshake: it reads the join frame, checks it
// against the room and session store, and joins the live room. A nil
// member means the connection was rejected and an error frame sent.
func (h *Handler) admit(ctx context.Context, conn *websocket.Conn) (*sfu.Member, chan sfu.Message, chan struct{}, func()) {
	noop := func() {}

	var first sfu.Message
	if !h.readFrame(ctx, conn, &first, joinTimeout) {
		return nil, nil, nil, noop
	}

	if first.Type != "join" {
		writeError(ctx, conn, "protocol", "Expected a join message.")

		return nil, nil, nil, noop
	}

	room, priv, ok := h.authenticate(ctx, conn, &first)
	if !ok {
		return nil, nil, nil, noop
	}

	done := make(chan struct{})

	var once sync.Once

	var member *sfu.Member

	teardown := func() {
		once.Do(func() {
			close(done)

			if member != nil {
				member.Leave()
			}

			_ = conn.Close(websocket.StatusNormalClosure, "")
		})
	}

	out := make(chan sfu.Message, outQueueDepth)

	member, err := h.Hub.JoinRoom(sfu.JoinRequest{
		Slug: room.Slug, RoomName: room.Name,
		MemberName: sanitizeName(first.Name),
		MaxMembers: room.MaxMembers,
		Priv:       priv,
	}, func(msg sfu.Message) {
		select {
		case out <- msg:
		case <-done:
		}
	})
	if err != nil {
		teardown()

		log.Printf("ws: join %s failed: %v", room.Slug, err)

		writeJoinError(ctx, conn, err)

		return nil, nil, nil, noop
	}

	return member, out, done, teardown
}

// writeJoinError reports a failed join attempt on the signaling channel.
func writeJoinError(ctx context.Context, conn *websocket.Conn, err error) {
	if errors.Is(err, sfu.ErrRoomFull) {
		writeError(ctx, conn, "room-full", "The room is full.")

		return
	}

	writeError(ctx, conn, "join-failed", "Could not join the room.")
}

// authenticate validates the join frame's room and session credentials
// and reports whether the session carries moderator rights.
func (h *Handler) authenticate(ctx context.Context, conn *websocket.Conn, first *sfu.Message) (*store.Room, bool, bool) {
	room, err := h.Store.GetRoom(ctx, first.Room)
	if err != nil {
		writeError(ctx, conn, "room-not-found", "No such room.")

		return nil, false, false
	}

	sess, err := h.Store.GetSession(ctx, first.Session)
	if err != nil || sess.Room != room.Slug {
		writeError(ctx, conn, "unauthorized", "Join authorization missing or expired.")

		return nil, false, false
	}

	return room, sess.Priv, true
}

func (h *Handler) readPump(ctx context.Context, conn *websocket.Conn, member *sfu.Member, teardown func()) {
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			teardown()

			return
		}

		var msg sfu.Message

		if json.Unmarshal(data, &msg) == nil {
			member.Handle(msg)
		}
	}
}

func (h *Handler) writePump(ctx context.Context, conn *websocket.Conn, out chan sfu.Message, done chan struct{}, teardown func()) {
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()

	for {
		select {
		case <-done:
			return
		case msg := <-out:
			data, err := json.Marshal(msg)
			if err != nil {
				continue
			}

			writeCtx, cancel := context.WithTimeout(ctx, frameTimeout)

			err = conn.Write(writeCtx, websocket.MessageText, data)

			cancel()

			if err != nil {
				teardown()

				return
			}
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(ctx, frameTimeout)

			err := conn.Ping(pingCtx)

			cancel()

			if err != nil {
				teardown()

				return
			}
		}
	}
}

// readFrame reads and decodes one message within timeout.
func (h *Handler) readFrame(ctx context.Context, conn *websocket.Conn, msg *sfu.Message, timeout time.Duration) bool {
	readCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	_, data, err := conn.Read(readCtx)
	if err != nil {
		return false
	}

	return json.Unmarshal(data, msg) == nil
}

func writeError(ctx context.Context, conn *websocket.Conn, code, text string) {
	data, err := json.Marshal(sfu.Message{Type: "error", Code: code, Text: text})
	if err != nil {
		return
	}

	writeCtx, cancel := context.WithTimeout(ctx, frameTimeout)
	defer cancel()

	_ = conn.Write(writeCtx, websocket.MessageText, data)
}

func sanitizeName(name string) string {
	name = strings.Map(func(r rune) rune {
		if r >= 0x20 && r != 0x7f {
			return r
		}

		return -1
	}, strings.TrimSpace(name))

	runes := []rune(name)
	if len(runes) > maxMemberName {
		name = string(runes[:maxMemberName])
	}

	if name == "" {
		return "Guest"
	}

	return name
}
