package recvbuf

import (
	"errors"
	"fmt"
	"syscall"
)

// kernelBufferCharge is how many bytes Linux reports for each byte of
// receive buffer it granted.
const kernelBufferCharge = 2

// grantedTo is the receive buffer the kernel gave socket. Linux cuts a
// request down to net.core.rmem_max without an error, and reports twice
// what it granted: it charges a socket for its own bookkeeping too.
func grantedTo(socket syscall.Conn) (int, error) {
	raw, err := socket.SyscallConn()
	if err != nil {
		return 0, fmt.Errorf("raw socket: %w", err)
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
		return 0, fmt.Errorf("read SO_RCVBUF: %w", err)
	}

	return reported / kernelBufferCharge, nil
}
