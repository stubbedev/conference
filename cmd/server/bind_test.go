package main

import (
	"bytes"
	"encoding/json"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"testing"

	"github.com/stubbe/conference/internal/config"
	"github.com/stubbe/conference/internal/recvbuf"
)

func TestReadyLineNamesKernelPickedPorts(t *testing.T) {
	t.Setenv("BIND", "127.0.0.1")
	t.Setenv("PORT", "0")
	t.Setenv("ICE_UDP_PORT", "0")
	t.Setenv("TURN_PORT", "0")

	cfg, err := config.FromEnv()
	if err != nil {
		t.Fatal(err)
	}

	bound, err := bind(t.Context(), cfg, recvbuf.NewSizer())
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() {
		_ = bound.http.Close()
		_ = bound.turn.Close()

		bound.closeEngine()
	})

	var out bytes.Buffer

	err = announce(&out, bound.readiness(cfg))
	if err != nil {
		t.Fatal(err)
	}

	ready := parseReadyLine(t, out.String())

	checkAnnouncedHTTP(t, ready, bound.http.Addr())
	checkAnnouncedICE(t, ready)
	checkAnnouncedTURN(t, ready, bound.turn.Credentials().ICEServers("127.0.0.1", "alice")[0].URLs)
}

func parseReadyLine(t *testing.T, announced string) readiness {
	t.Helper()

	line, found := strings.CutPrefix(announced, readyPrefix)
	if !found || strings.Count(line, "\n") != 1 || !strings.HasSuffix(line, "\n") {
		t.Fatalf("announced %q, want one line starting with %q", announced, readyPrefix)
	}

	var ready readiness

	err := json.Unmarshal([]byte(line), &ready)
	if err != nil {
		t.Fatalf("ready line %q: %v", line, err)
	}

	return ready
}

func checkAnnouncedHTTP(t *testing.T, ready readiness, bound net.Addr) {
	t.Helper()

	httpAddr := netip.MustParseAddrPort(ready.HTTP)
	if httpAddr.Port() == 0 || ready.HTTP != bound.String() {
		t.Fatalf("announced http %q, bound %s", ready.HTTP, bound)
	}

	var dialer net.Dialer

	conn, err := dialer.DialContext(t.Context(), "tcp", ready.HTTP)
	if err != nil {
		t.Fatalf("dial the announced http address: %v", err)
	}

	_ = conn.Close()
}

func checkAnnouncedICE(t *testing.T, ready readiness) {
	t.Helper()

	if len(ready.ICEUDP) == 0 {
		t.Fatal("announced no ICE address")
	}

	for _, raw := range ready.ICEUDP {
		if netip.MustParseAddrPort(raw).Port() == 0 {
			t.Fatalf("announced ICE address %q without its port", raw)
		}
	}
}

func checkAnnouncedTURN(t *testing.T, ready readiness, urls []string) {
	t.Helper()

	if ready.TURN == 0 {
		t.Fatal("announced TURN port 0")
	}

	turnHost := ":" + strconv.Itoa(ready.TURN) + "?"
	for _, url := range urls {
		if !strings.Contains(url, turnHost) {
			t.Fatalf("TURN URL %q does not carry the announced port %d", url, ready.TURN)
		}
	}
}
