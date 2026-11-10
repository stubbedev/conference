//go:build linux

package relay

import (
	"net"
	"testing"

	"github.com/pion/turn/v5"

	"github.com/stubbe/conference/internal/recvbuf"
	"github.com/stubbe/conference/internal/recvbuf/recvbuftest"
)

// TestRelaySocketHoldsABurstNobodyReads sends a burst from the SFU to
// the relay socket of an allocation whose reader is not running, as a
// server short of CPU leaves it, and checks that every packet is still
// there when the reader comes back.
func TestRelaySocketHoldsABurstNobodyReads(t *testing.T) {
	t.Parallel()

	recvbuftest.SkipUnlessGranted(t, recvbuf.Requested)

	var listenConfig net.ListenConfig

	sfu, err := listenConfig.ListenPacket(t.Context(), "udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	t.Cleanup(func() { _ = sfu.Close() })

	local, err := addrPort(sfu.LocalAddr())
	if err != nil {
		t.Fatal(err)
	}

	relays, err := newSFURelay([]MediaAddr{{Announced: local, Local: local}}, recvbuf.NewSizer())
	if err != nil {
		t.Fatal(err)
	}

	relayed, _, err := relays.AllocatePacketConn(turn.AllocateListenerConfig{
		Network: udpNetwork(local.Addr()), UserID: "alice", Realm: realm, RequestedPort: 0,
	})
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = relayed.Close() })

	recvbuftest.Send(t, sfu, relayed.LocalAddr())
	recvbuftest.RequireHeld(t, relayed)
}
