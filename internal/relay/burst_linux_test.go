package relay_test

import (
	"sync/atomic"
	"testing"
	"time"

	"github.com/stubbe/conference/internal/recvbuf"
	"github.com/stubbe/conference/internal/recvbuf/recvbuftest"
	"github.com/stubbe/conference/internal/relay"
)

// busyRelay is a membership check a test can hold, and with it the
// relay: the relay checks a member on the loop that reads its listening
// socket, so nothing is read off that socket until the check returns.
type busyRelay struct {
	held     atomic.Bool
	checking chan struct{}
	release  chan struct{}
}

func newBusyRelay() *busyRelay {
	return &busyRelay{held: atomic.Bool{}, checking: make(chan struct{}, 1), release: make(chan struct{})}
}

func (b *busyRelay) live(id string) bool {
	if b.held.Load() {
		select {
		case b.checking <- struct{}{}:
		default:
		}

		<-b.release
	}

	return id == member
}

// TestRelayHoldsABurstWhileItIsBusy sends a publisher's burst through
// the relay while the relay is not reading its listening socket, as a
// server short of CPU leaves it, and checks that every packet reaches
// the SFU once it reads again.
func TestRelayHoldsABurstWhileItIsBusy(t *testing.T) {
	t.Parallel()

	recvbuftest.SkipUnlessGranted(t, recvbuf.Requested)

	sfu := listenUDP(t, "127.0.0.1:0")

	err := recvbuf.NewSizer().Size(sfu)
	if err != nil {
		t.Fatal(err)
	}

	local := addrPort(t, sfu.LocalAddr())
	busy := newBusyRelay()
	port, server := startRelayFor(t, []relay.MediaAddr{{Announced: local, Local: local}}, busy.live)

	publisher, err := allocate(t, port, server.Username, server.Credential)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}

	_, err = publisher.WriteTo([]byte("ping"), sfu.LocalAddr())
	if err != nil {
		t.Fatalf("write to SFU: %v", err)
	}

	read(t, sfu)

	busy.held.Store(true)

	joining := turnClient(t, port, server.Username, server.Credential)
	joined := make(chan error, 1)

	go func() {
		conn, allocateErr := joining.Allocate()
		if allocateErr == nil {
			allocateErr = conn.Close()
		}

		joined <- allocateErr
	}()

	select {
	case <-busy.checking:
	case <-time.After(readTimeout):
		t.Fatal("the relay never checked the joining member, so it was never busy")
	}

	recvbuftest.Send(t, publisher, sfu.LocalAddr())
	close(busy.release)
	recvbuftest.RequireHeld(t, sfu)

	err = <-joined
	if err != nil {
		t.Fatalf("the member that kept the relay busy: %v", err)
	}
}
