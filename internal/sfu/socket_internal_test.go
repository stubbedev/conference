package sfu

import (
	"errors"
	"net"
	"sync/atomic"
	"syscall"
	"testing"

	"github.com/pion/transport/v4"
	"github.com/pion/webrtc/v4"

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

const muxBindAttempts = 10

// TestMuxSocketsAreMediaSockets: the sockets of the shared UDP port are
// the ones every publisher's packets arrive on, so they are opened on the
// media net and get its receive buffer.
func TestMuxSocketsAreMediaSockets(t *testing.T) {
	t.Parallel()

	for range muxBindAttempts {
		sockets := newCountingNet(t)

		_, _, closeMux, err := newSettingEngine(sockets, freeUDPPort(t), nil)
		if errors.Is(err, syscall.EADDRINUSE) {
			continue
		}

		if err != nil {
			t.Fatal(err)
		}

		closeMux()

		if sockets.opened.Load() == 0 {
			t.Fatal("the mux opened its sockets beside the media net, so they keep the kernel's default receive buffer")
		}

		return
	}

	t.Fatalf("no free mux port after %d attempts", muxBindAttempts)
}

// TestEphemeralSocketsAreMediaSockets: without a shared port every
// connection gathers on sockets of its own, opened on the media net too.
func TestEphemeralSocketsAreMediaSockets(t *testing.T) {
	t.Parallel()

	sockets := newCountingNet(t)

	settingEngine, _, _, err := newSettingEngine(sockets, 0, nil)
	if err != nil {
		t.Fatal(err)
	}

	engine, err := newEngine(settingEngine, nil)
	if err != nil {
		t.Fatal(err)
	}

	peerConn, err := engine.NewUpstreamPeerConnection(UpstreamScreen)
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = peerConn.Close() })

	_, err = peerConn.CreateDataChannel("gather", nil)
	if err != nil {
		t.Fatalf("data channel: %v", err)
	}

	offer, err := peerConn.CreateOffer(nil)
	if err != nil {
		t.Fatalf("offer: %v", err)
	}

	gathered := webrtc.GatheringCompletePromise(peerConn)

	err = peerConn.SetLocalDescription(offer)
	if err != nil {
		t.Fatalf("local description: %v", err)
	}

	<-gathered

	if sockets.opened.Load() == 0 {
		t.Fatal("the connection gathered on sockets opened beside the media net, so they keep the kernel's default receive buffer")
	}
}

func freeUDPPort(t *testing.T) int {
	t.Helper()

	var listenConfig net.ListenConfig

	conn, err := listenConfig.ListenPacket(t.Context(), "udp4", ":0")
	if err != nil {
		t.Fatalf("reserve udp port: %v", err)
	}

	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok {
		t.Fatalf("reserve udp port: local address %v is not UDP", conn.LocalAddr())
	}

	err = conn.Close()
	if err != nil {
		t.Fatalf("release udp port %d: %v", addr.Port, err)
	}

	return addr.Port
}
