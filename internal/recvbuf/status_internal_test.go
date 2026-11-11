package recvbuf

import "testing"

// TestStatusReportsTheLeastGranted: one socket with a small buffer is
// enough to lose a burst, so the status is the smallest grant, and a
// socket that got more afterwards does not hide it.
func TestStatusReportsTheLeastGranted(t *testing.T) {
	t.Parallel()

	const (
		stockLimit = 212992
		lowerLimit = stockLimit / 2
	)

	sockets := NewSizer()

	if got, want := sockets.Status(), (Status{Requested: Requested, Granted: Requested}); got != want {
		t.Fatalf("status %+v before any socket, want %+v: no socket got less than it asked for", got, want)
	}

	for _, step := range []struct {
		granted int
		want    int
	}{
		{granted: Requested, want: Requested},
		{granted: stockLimit, want: stockLimit},
		{granted: Requested, want: stockLimit},
		{granted: lowerLimit, want: lowerLimit},
	} {
		sockets.record(step.granted)

		if got := sockets.Status(); got != (Status{Requested: Requested, Granted: step.want}) {
			t.Fatalf("status %+v after a socket was granted %d bytes, want %d granted", got, step.granted, step.want)
		}
	}
}
