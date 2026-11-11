package sfu_test

import (
	"net/netip"
	"strings"
	"testing"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"

	"github.com/stubbe/conference/internal/recvbuf"
	"github.com/stubbe/conference/internal/sfu"
)

func testExternalIP() netip.Addr {
	return netip.MustParseAddr("203.0.113.10")
}

func newEngine(t *testing.T) *sfu.Engine {
	t.Helper()

	engine, closeEngine, err := sfu.NewEngine(0, []netip.Addr{testExternalIP()}, recvbuf.NewSizer())
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(closeEngine)

	return engine
}

func gatheredSDP(t *testing.T, engine *sfu.Engine) string {
	t.Helper()

	connection, err := engine.NewUpstreamPeerConnection(sfu.UpstreamMedia)
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

	engine := newEngine(t)

	hosts := ipv4HostCandidates(t, gatheredSDP(t, engine))
	if len(hosts) == 0 {
		t.Fatal("no IPv4 host candidates gathered")
	}

	announced := engine.MediaAddrs()[0].Announced
	offered := false

	for _, candidate := range hosts {
		if candidate.Address() != testExternalIP().String() {
			t.Errorf("host candidate %s:%d announced, want only %s", candidate.Address(), candidate.Port(), testExternalIP())
		}

		if candidate.Port() == 0 {
			t.Errorf("host candidate %s announced without the port its mux socket is bound to", candidate.Address())
		}

		if candidate.Port() == int(announced.Port()) {
			offered = true
		}
	}

	if !offered {
		t.Errorf("no host candidate on the relayed media address %s", announced)
	}
}

func TestEngineMediaAddrs(t *testing.T) {
	t.Parallel()

	addrs := newEngine(t).MediaAddrs()
	if len(addrs) != 1 {
		t.Fatalf("media addrs %v, want one for the single IPv4 external IP", addrs)
	}

	local := addrs[0].Local
	if !local.Addr().Is4() || local.Port() == 0 {
		t.Fatalf("local %s, want an IPv4 mux socket on the port the kernel picked", local)
	}

	want := netip.AddrPortFrom(testExternalIP(), local.Port())
	if addrs[0].Announced != want {
		t.Fatalf("announced %s, want %s", addrs[0].Announced, want)
	}
}
