package sfu_test

import (
	"errors"
	"net"
	"net/netip"
	"strings"
	"syscall"
	"testing"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"

	"github.com/stubbe/conference/internal/sfu"
)

func testExternalIP() netip.Addr {
	return netip.MustParseAddr("203.0.113.10")
}

const muxBindAttempts = 10

// newEngine builds an engine on the given port, or, with mux, on a
// free fixed port: the mux binds every interface, so a port reserved a
// moment ago can still be taken by a parallel test's ephemeral ICE
// socket, and the bind is retried on a fresh port.
func newEngine(t *testing.T, mux bool) (*sfu.Engine, int) {
	t.Helper()

	for range muxBindAttempts {
		port := 0
		if mux {
			port = freeUDPPort(t)
		}

		engine, closeEngine, err := sfu.NewEngine(port, []netip.Addr{testExternalIP()})
		if mux && errors.Is(err, syscall.EADDRINUSE) {
			continue
		}

		if err != nil {
			t.Fatal(err)
		}

		t.Cleanup(closeEngine)

		return engine, port
	}

	t.Fatalf("no free mux port after %d attempts", muxBindAttempts)

	return nil, 0
}

func freeUDPPort(t *testing.T) int {
	t.Helper()

	var listenConfig net.ListenConfig

	conn, err := listenConfig.ListenPacket(t.Context(), "udp4", ":0")
	if err != nil {
		t.Fatalf("reserve udp port: %v", err)
	}

	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok {
		t.Fatalf("reserve udp port: local address %v is not UDP", conn.LocalAddr())
	}

	err = conn.Close()
	if err != nil {
		t.Fatalf("release udp port %d: %v", addr.Port, err)
	}

	return addr.Port
}

func gatheredSDP(t *testing.T, engine *sfu.Engine) string {
	t.Helper()

	connection, err := engine.NewPeerConnection()
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = connection.Close() })

	_, err = connection.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio)
	if err != nil {
		t.Fatalf("add transceiver: %v", err)
	}

	gathered := webrtc.GatheringCompletePromise(connection)

	offer, err := connection.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}

	err = connection.SetLocalDescription(offer)
	if err != nil {
		t.Fatalf("set local description: %v", err)
	}

	<-gathered

	return connection.LocalDescription().SDP
}

func ipv4HostCandidates(t *testing.T, sdp string) []ice.Candidate {
	t.Helper()

	var hosts []ice.Candidate

	for line := range strings.SplitSeq(sdp, "\r\n") {
		value, ok := strings.CutPrefix(line, "a=")
		if !ok || !strings.HasPrefix(value, "candidate:") {
			continue
		}

		candidate, err := ice.UnmarshalCandidate(value)
		if err != nil {
			t.Fatalf("parse candidate %q: %v", value, err)
		}

		if candidate.Type() == ice.CandidateTypeHost && candidate.NetworkType() == ice.NetworkTypeUDP4 {
			hosts = append(hosts, candidate)
		}
	}

	return hosts
}

func TestEngineAnnouncesExternalIPs(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name string
		mux  bool
	}{
		{name: "shared udp mux", mux: true},
		{name: "ephemeral ports", mux: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			engine, port := newEngine(t, tc.mux)

			hosts := ipv4HostCandidates(t, gatheredSDP(t, engine))
			if len(hosts) == 0 {
				t.Fatal("no IPv4 host candidates gathered")
			}

			for _, candidate := range hosts {
				if candidate.Address() != testExternalIP().String() {
					t.Errorf("host candidate %s:%d announced, want only %s", candidate.Address(), candidate.Port(), testExternalIP())
				}

				if tc.mux && candidate.Port() != port {
					t.Errorf("host candidate port %d, want the mux port %d", candidate.Port(), port)
				}
			}
		})
	}
}

func TestEngineMediaAddrs(t *testing.T) {
	t.Parallel()

	engine, port := newEngine(t, true)

	addrs := engine.MediaAddrs()
	if len(addrs) != 1 {
		t.Fatalf("media addrs %v, want one for the single IPv4 external IP", addrs)
	}

	want := netip.AddrPortFrom(testExternalIP(), uint16(port)) //nolint:gosec // freeUDPPort returns a valid port.
	if addrs[0].Announced != want {
		t.Fatalf("announced %s, want %s", addrs[0].Announced, want)
	}

	if !addrs[0].Local.Addr().Is4() || addrs[0].Local.Port() != uint16(port) { //nolint:gosec // as above.
		t.Fatalf("local %s, want an IPv4 mux socket on port %d", addrs[0].Local, port)
	}

	ephemeral, _ := newEngine(t, false)

	if got := ephemeral.MediaAddrs(); len(got) != 0 {
		t.Fatalf("ephemeral engine announced media addrs %v", got)
	}
}
