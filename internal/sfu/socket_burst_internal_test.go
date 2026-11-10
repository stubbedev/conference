//go:build linux

package sfu

import (
	"net"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// A burst no default socket holds: the kernel's default receive buffer
// takes 92 packets of this size.
const (
	burstPacketBytes = 1200
	burstOfPackets   = 1000
	burstReadTimeout = 2 * time.Second
)

// TestMediaSocketHoldsABurstNobodyReads sends a burst to a media socket
// whose reader is not running, as a server short of CPU leaves it, and
// checks that every packet is still there when the reader comes back.
func TestMediaSocketHoldsABurstNobodyReads(t *testing.T) {
	t.Parallel()

	if limit := receiveBufferCap(t); limit < mediaReceiveBuffer {
		t.Skipf("this kernel caps receive buffers at %d bytes, below the %d a media socket asks for", limit, mediaReceiveBuffer)
	}

	sockets, err := newMediaNet()
	if err != nil {
		t.Fatal(err)
	}

	receiver, err := sockets.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 0, Zone: ""})
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = receiver.Close() })

	granted, err := grantedReceiveBuffer(receiver)
	if err != nil {
		t.Fatal(err)
	}

	if granted != mediaReceiveBuffer {
		t.Fatalf("the media socket was granted a receive buffer of %d bytes, want %d", granted, mediaReceiveBuffer)
	}

	sendBurst(t, receiver.LocalAddr())

	packet := make([]byte, burstPacketBytes)

	for held := range burstOfPackets {
		err = receiver.SetReadDeadline(time.Now().Add(burstReadTimeout))
		if err != nil {
			t.Fatalf("read deadline: %v", err)
		}

		_, _, err = receiver.ReadFrom(packet)
		if err != nil {
			t.Fatalf("the socket held %d packets of a burst of %d: %v", held, burstOfPackets, err)
		}
	}
}

func sendBurst(t *testing.T, receiver net.Addr) {
	t.Helper()

	var dialer net.Dialer

	sender, err := dialer.DialContext(t.Context(), receiver.Network(), receiver.String())
	if err != nil {
		t.Fatalf("dial the media socket: %v", err)
	}

	defer func() { _ = sender.Close() }()

	packet := make([]byte, burstPacketBytes)

	for sent := range burstOfPackets {
		_, err = sender.Write(packet)
		if err != nil {
			t.Fatalf("packet %d of the burst: %v", sent, err)
		}
	}
}

// receiveBufferCap is the largest receive buffer this kernel grants a
// socket that asks for one.
func receiveBufferCap(t *testing.T) int {
	t.Helper()

	const setting = "/proc/sys/net/core/rmem_max"

	raw, err := os.ReadFile(setting)
	if err != nil {
		t.Fatalf("read %s: %v", setting, err)
	}

	limit, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatalf("parse %s: %v", setting, err)
	}

	return limit
}
