package sfu

import (
	"fmt"
	"net"

	"github.com/pion/transport/v4"
	"github.com/pion/transport/v4/stdnet"

	"github.com/stubbe/conference/internal/recvbuf"
)

// mediaNet is the network the engine opens its sockets on: the system's,
// with every UDP socket sized for media.
type mediaNet struct {
	transport.Net

	sockets *recvbuf.Sizer
}

func newMediaNet(sockets *recvbuf.Sizer) (mediaNet, error) {
	system, err := stdnet.NewNet()
	if err != nil {
		return mediaNet{}, fmt.Errorf("sfu: network interfaces: %w", err)
	}

	return mediaNet{Net: system, sockets: sockets}, nil
}

// ListenUDP opens a UDP socket with the media receive buffer.
//
//nolint:ireturn // the signature transport.Net sets
func (n mediaNet) ListenUDP(network string, local *net.UDPAddr) (transport.UDPConn, error) {
	conn, err := n.Net.ListenUDP(network, local)
	if err != nil {
		return nil, fmt.Errorf("media socket: %w", err)
	}

	err = n.sockets.Size(conn)
	if err != nil {
		_ = conn.Close()

		return nil, fmt.Errorf("media socket: %w", err)
	}

	return conn, nil
}
