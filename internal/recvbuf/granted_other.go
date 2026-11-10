//go:build !linux

package recvbuf

import "syscall"

// grantedTo takes the buffer as granted in full: reading it back is
// written for Linux alone, the kernel that cuts a request down without
// an error.
func grantedTo(syscall.Conn) (int, error) {
	return Requested, nil
}
