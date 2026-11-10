package recvbuf_test

import (
	"net"
	"testing"

	"github.com/stubbe/conference/internal/recvbuf"
)

// TestSizeRefusesASocketItCannotSize: a connection that is not the
// system's own has no receive buffer to set, and passing for sized
// would leave it with whatever it has.
func TestSizeRefusesASocketItCannotSize(t *testing.T) {
	t.Parallel()

	ours, theirs := net.Pipe()

	t.Cleanup(func() {
		_ = ours.Close()
		_ = theirs.Close()
	})

	err := recvbuf.NewSizer().Size(inMemory{Conn: ours})
	if err == nil {
		t.Fatal("an in-memory connection passed for a sized socket")
	}
}

// inMemory is a packet connection with no socket behind it.
type inMemory struct {
	net.Conn
}

func (c inMemory) ReadFrom(payload []byte) (int, net.Addr, error) {
	read, err := c.Read(payload)

	return read, c.RemoteAddr(), err
}

func (c inMemory) WriteTo(payload []byte, _ net.Addr) (int, error) {
	//nolint:wrapcheck // a pass-through, the error is the pipe's own
	return c.Write(payload)
}
