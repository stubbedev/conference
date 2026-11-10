//go:build !linux

package sfu

import "github.com/pion/transport/v4"

// grantedReceiveBuffer takes the buffer as granted in full: reading it
// back is written for Linux alone, the kernel that cuts a request down
// without an error.
func grantedReceiveBuffer(transport.UDPConn) (int, error) {
	return mediaReceiveBuffer, nil
}
