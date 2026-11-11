package sfu

import (
	"net"
	"sync/atomic"
	"testing"

	"github.com/pion/transport/v4"

	"github.com/stubbe/conference/internal/recvbuf"
)

// countingNet counts the UDP sockets opened on it.
type countingNet struct {
	transport.Net

	opened atomic.Int32
}

//nolint:ireturn // the signature transport.Net sets
func (n *countingNet) ListenUDP(network string, local *net.UDPAddr) (transport.UDPConn, error) {
	n.opened.Add(1)

	//nolint:wrapcheck // a pass-through, the error is the media net's own
	return n.Net.ListenUDP(network, local)
}

func newCountingNet(t *testing.T) *countingNet {
	t.Helper()

	sockets, err := newMediaNet(recvbuf.NewSizer())
	if err != nil {
		t.Fatal(err)
	}

	return &countingNet{Net: sockets, opened: atomic.Int32{}}
}

// TestMuxSocketsAreMediaSockets: the sockets of the shared UDP port are
// the ones every publisher's packets arrive on, so they are opened on the
// media net and get its receive buffer.
func TestMuxSocketsAreMediaSockets(t *testing.T) {
	t.Parallel()

	sockets := newCountingNet(t)

	_, _, closeMux, err := newSettingEngine(sockets, 0, nil)
	if err != nil {
		t.Fatal(err)
	}

	closeMux()

	if sockets.opened.Load() == 0 {
		t.Fatal("the mux opened its sockets beside the media net, so they keep the kernel's default receive buffer")
	}
}
