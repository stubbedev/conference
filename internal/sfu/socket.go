package sfu

import (
	"fmt"
	"log"
	"net"
	"sync"

	"github.com/pion/transport/v4"
	"github.com/pion/transport/v4/stdnet"
)

// mediaReceiveBuffer is the receive buffer every media socket asks the
// kernel for. A browser sends a frame as one burst: on a connection whose
// estimate nothing limits its pacer holds nothing back, so a keyframe of
// a shared screen is a few hundred packets at once. The kernel's default
// buffer holds 92 media-sized packets; what arrives beyond it while the
// reader waits for a CPU is dropped, and reads as loss on the publisher's
// uplink. This holds 3640.
const mediaReceiveBuffer = 4 << 20

// mediaNet is the network the engine opens its sockets on: the system's,
// with every UDP socket sized for media.
type mediaNet struct {
	transport.Net

	// short reports once that the kernel grants less than was asked for.
	short *sync.Once
}

func newMediaNet() (mediaNet, error) {
	system, err := stdnet.NewNet()
	if err != nil {
		return mediaNet{}, fmt.Errorf("sfu: network interfaces: %w", err)
	}

	return mediaNet{Net: system, short: &sync.Once{}}, nil
}

// ListenUDP opens a UDP socket with the media receive buffer.
//
//nolint:ireturn // the signature transport.Net sets
func (n mediaNet) ListenUDP(network string, local *net.UDPAddr) (transport.UDPConn, error) {
	conn, err := n.Net.ListenUDP(network, local)
	if err != nil {
		return nil, fmt.Errorf("media socket: %w", err)
	}

	err = n.size(conn)
	if err != nil {
		_ = conn.Close()

		return nil, fmt.Errorf("media socket %s: %w", conn.LocalAddr(), err)
	}

	return conn, nil
}

func (n mediaNet) size(conn transport.UDPConn) error {
	err := conn.SetReadBuffer(mediaReceiveBuffer)
	if err != nil {
		return fmt.Errorf("receive buffer of %d bytes: %w", mediaReceiveBuffer, err)
	}

	granted, err := grantedReceiveBuffer(conn)
	if err != nil {
		return err
	}

	if granted < mediaReceiveBuffer {
		n.short.Do(func() {
			log.Printf("sfu: the kernel grants media sockets a receive buffer of %d bytes, not the %d asked for: "+
				"bursts of video beyond it are dropped while the server is busy; raise net.core.rmem_max to %d",
				granted, mediaReceiveBuffer, mediaReceiveBuffer)
		})
	}

	return nil
}
