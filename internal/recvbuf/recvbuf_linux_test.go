package recvbuf_test

import (
	"net"
	"testing"

	"github.com/stubbe/conference/internal/recvbuf"
	"github.com/stubbe/conference/internal/recvbuf/recvbuftest"
)

// TestSizedSocketHoldsABurstNobodyReads sends a burst to a sized socket
// whose reader is not running, as a server short of CPU leaves it, and
// checks that every packet is still there when the reader comes back.
func TestSizedSocketHoldsABurstNobodyReads(t *testing.T) {
	t.Parallel()

	recvbuftest.SkipUnlessGranted(t, recvbuf.Requested)

	receiver := listen(t)

	err := recvbuf.NewSizer().Size(receiver)
	if err != nil {
		t.Fatal(err)
	}

	recvbuftest.Send(t, listen(t), receiver.LocalAddr())
	recvbuftest.RequireHeld(t, receiver)
}

func listen(t *testing.T) net.PacketConn {
	t.Helper()

	var listenConfig net.ListenConfig

	conn, err := listenConfig.ListenPacket(t.Context(), "udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	t.Cleanup(func() { _ = conn.Close() })

	return conn
}
