// Package recvbuftest sends media sockets the burst their tests must see
// held: more packets at once than the kernel's default receive buffer
// keeps while nobody reads.
package recvbuftest

import (
	"net"
	"testing"
	"time"
)

// A burst no default socket holds: the kernel's default receive buffer
// takes 92 packets of this size.
const (
	PacketBytes = 1200
	Packets     = 1000

	readTimeout = 2 * time.Second
)

// Send sends the burst from sender to receiver.
func Send(t *testing.T, sender net.PacketConn, receiver net.Addr) {
	t.Helper()

	packet := make([]byte, PacketBytes)

	for sent := range Packets {
		_, err := sender.WriteTo(packet, receiver)
		if err != nil {
			t.Fatalf("packet %d of the burst to %s: %v", sent, receiver, err)
		}
	}
}

// RequireHeld reads the burst off conn, and fails the test at the first
// packet of it that is not there.
func RequireHeld(t *testing.T, conn net.PacketConn) {
	t.Helper()

	packet := make([]byte, PacketBytes)

	for held := range Packets {
		err := conn.SetReadDeadline(time.Now().Add(readTimeout))
		if err != nil {
			t.Fatalf("read deadline: %v", err)
		}

		_, _, err = conn.ReadFrom(packet)
		if err != nil {
			t.Fatalf("%s held %d packets of a burst of %d: %v", conn.LocalAddr(), held, Packets, err)
		}
	}
}
