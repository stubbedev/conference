// Package recvbuf sizes the receive buffer of the UDP sockets media
// arrives on, for the SFU and for the relay in front of it.
package recvbuf

import (
	"errors"
	"fmt"
	"log"
	"net"
	"sync"
	"syscall"
)

// Requested is the receive buffer every media socket asks the kernel for.
// A browser sends a frame as one burst: on a connection whose estimate
// nothing limits its pacer holds nothing back, so a keyframe of a shared
// screen is a few hundred packets at once. The kernel's default buffer
// holds 92 media-sized packets; what arrives beyond it while the reader
// waits for a CPU is dropped, and reads as loss on the sender's link.
// This holds 3640.
const Requested = 4 << 20

var errNotASystemSocket = errors.New("not a system socket")

// systemSocket is a socket of the operating system's, the only kind
// whose receive buffer can be set and read back.
type systemSocket interface {
	SetReadBuffer(bytes int) error
	syscall.Conn
}

// Sizer sizes the media sockets of one server and remembers the least
// the kernel granted any of them.
type Sizer struct {
	mu sync.Mutex

	// least is what the socket that got the least was granted: Requested
	// until one gets less.
	least int
}

// Status is what the media sockets asked the kernel for and what the one
// that got the least was granted. Granted below Requested means bursts
// of video can be dropped, and that net.core.rmem_max is what holds the
// buffer down.
type Status struct {
	Requested int `json:"requested"`
	Granted   int `json:"granted"`
}

// NewSizer is a Sizer no socket has been sized by yet.
func NewSizer() *Sizer {
	return &Sizer{mu: sync.Mutex{}, least: Requested}
}

// Size asks the kernel for Requested bytes of receive buffer on conn. A
// kernel that grants less is not an error: the socket works, and the
// first socket to get less than every one before it says so in the log.
func (s *Sizer) Size(conn net.PacketConn) error {
	socket, ok := conn.(systemSocket)
	if !ok {
		return fmt.Errorf("receive buffer of %s: %w: %T", conn.LocalAddr(), errNotASystemSocket, conn)
	}

	err := socket.SetReadBuffer(Requested)
	if err != nil {
		return fmt.Errorf("receive buffer of %d bytes on %s: %w", Requested, conn.LocalAddr(), err)
	}

	granted, err := grantedTo(socket)
	if err != nil {
		return fmt.Errorf("receive buffer granted to %s: %w", conn.LocalAddr(), err)
	}

	s.record(granted)

	return nil
}

// Status reports the least any socket sized so far was granted: all that
// was asked for, until one gets less.
func (s *Sizer) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()

	return Status{Requested: Requested, Granted: s.least}
}

func (s *Sizer) record(granted int) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if granted >= s.least {
		return
	}

	s.least = granted

	log.Printf("recvbuf: the kernel grants media sockets a receive buffer of %d bytes, not the %d asked for: "+
		"bursts of video beyond it are dropped while the server is busy; "+
		"raise net.core.rmem_max to %d on the host and restart the server",
		granted, Requested, Requested)
}
