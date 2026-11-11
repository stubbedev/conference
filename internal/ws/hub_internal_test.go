package ws

import (
	"bytes"
	"context"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/coder/websocket"

	"github.com/stubbe/conference/internal/sfu"
)

func TestUnencodableMessageClosesTheConnection(t *testing.T) { //nolint:paralleltest // reads the process-wide logger.
	var logged bytes.Buffer

	previous := log.Writer()

	log.SetOutput(&logged)
	t.Cleanup(func() { log.SetOutput(previous) })

	var tornDown atomic.Bool

	served := make(chan struct{})

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(served)

		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept: %v", err)

			return
		}

		out := make(chan sfu.Message, 1)
		out <- sfu.Message{Type: "join"}

		var handler Handler

		handler.writePump(context.WithoutCancel(r.Context()), conn, "anna", out, make(chan struct{}), func() { tornDown.Store(true) })
	}))
	t.Cleanup(server.Close)

	conn, res, err := websocket.Dial(t.Context(), "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if res != nil && res.Body != nil {
		_ = res.Body.Close()
	}

	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	defer func() { _ = conn.CloseNow() }()

	_, _, err = conn.Read(t.Context())

	var closed websocket.CloseError
	if !errors.As(err, &closed) || closed.Code != websocket.StatusInternalError {
		t.Fatalf("read = %v, want a close with %v", err, websocket.StatusInternalError)
	}

	<-served

	if !tornDown.Load() {
		t.Error("the member was not torn down")
	}

	if !strings.Contains(logged.String(), "member anna: encode a join message") {
		t.Errorf("logged %q, want the member and the message type", logged.String())
	}
}
