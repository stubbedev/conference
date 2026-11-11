//go:build linux

package sfu

import (
	"net"
	"testing"

	"github.com/pion/transport/v4"

	"github.com/stubbe/conference/internal/recvbuf"
	"github.com/stubbe/conference/internal/recvbuf/recvbuftest"
)

// TestMediaSocketHoldsABurstNobodyReads sends a burst to a media socket
// whose reader is not running, as a server short of CPU leaves it, and
// checks that every packet is still there when the reader comes back.
func TestMediaSocketHoldsABurstNobodyReads(t *testing.T) {
	t.Parallel()

	recvbuftest.SkipUnlessGranted(t, recvbuf.Requested)

	sockets, err := newMediaNet(recvbuf.NewSizer())
	if err != nil {
		t.Fatal(err)
	}

	sender, receiver := listenLoopback(t, sockets), listenLoopback(t, sockets)

	recvbuftest.Send(t, sender, receiver.LocalAddr())
	recvbuftest.RequireHeld(t, receiver)
}

//nolint:ireturn // the socket as transport.Net hands it out
func listenLoopback(t *testing.T, sockets mediaNet) transport.UDPConn {
	t.Helper()

	conn, err := sockets.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0, Zone: ""})
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = conn.Close() })

	return conn
}
