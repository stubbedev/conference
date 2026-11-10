package sfu

import (
	"errors"
	"fmt"
	"syscall"

	"github.com/pion/transport/v4"
)

var errNotASystemSocket = errors.New("not a system socket")

// kernelBufferCharge is how many bytes Linux reports for each byte of
// receive buffer it granted.
const kernelBufferCharge = 2

// grantedReceiveBuffer is the receive buffer the kernel gave conn. Linux
// cuts a request down to net.core.rmem_max without an error, and reports
// twice what it granted: it charges a socket for its own bookkeeping too.
func grantedReceiveBuffer(conn transport.UDPConn) (int, error) {
	system, ok := conn.(syscall.Conn)
	if !ok {
		return 0, fmt.Errorf("granted receive buffer: %w: %T", errNotASystemSocket, conn)
	}

	raw, err := system.SyscallConn()
	if err != nil {
		return 0, fmt.Errorf("granted receive buffer: %w", err)
	}

	var (
		reported int
		readErr  error
	)

	err = raw.Control(func(fd uintptr) {
		reported, readErr = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF)
	})

	err = errors.Join(err, readErr)
	if err != nil {
		return 0, fmt.Errorf("granted receive buffer: %w", err)
	}

	return reported / kernelBufferCharge, nil
}
