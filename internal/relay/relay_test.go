package relay_test

import (
	"bytes"
	"errors"
	"net"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/pion/turn/v5"

	"github.com/stubbe/conference/internal/relay"
)

const (
	member      = "alice"
	stranger    = "mallory"
	readTimeout = 2 * time.Second
	quietPeriod = 300 * time.Millisecond
)

var errUDPOnly = errors.New("not a UDP address")

func listenUDP(t *testing.T, addr string) net.PacketConn {
	t.Helper()

	var listenConfig net.ListenConfig

	conn, err := listenConfig.ListenPacket(t.Context(), "udp4", addr)
	if err != nil {
		t.Fatalf("listen %s: %v", addr, err)
	}

	t.Cleanup(func() { _ = conn.Close() })

	return conn
}

func addrPort(t *testing.T, addr net.Addr) netip.AddrPort {
	t.Helper()

	udp, ok := addr.(*net.UDPAddr)
	if !ok {
		t.Fatalf("%v: %v", errUDPOnly, addr)
	}

	return udp.AddrPort()
}

func freeTURNPort(t *testing.T) int {
	t.Helper()

	var listenConfig net.ListenConfig

	listener, err := listenConfig.Listen(t.Context(), "tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve tcp port: %v", err)
	}

	addr, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("reserve tcp port: %v is not TCP", listener.Addr())
	}

	err = listener.Close()
	if err != nil {
		t.Fatalf("release tcp port %d: %v", addr.Port, err)
	}

	return addr.Port
}

// startRelay runs a TURN server for media and returns credentials for
// the always-live member.
func startRelay(t *testing.T, media []relay.MediaAddr) (int, relay.ICEServer) {
	t.Helper()

	port := freeTURNPort(t)

	creds, err := relay.NewCredentials(relay.Config{Port: port, TLSHost: ""})
	if err != nil {
		t.Fatal(err)
	}

	server, err := relay.Start(t.Context(), creds, media, func(id string) bool { return id == member })
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = server.Close() })

	return port, creds.ICEServers("127.0.0.1", member)[0]
}

func allocate(t *testing.T, port int, username, password string) (net.PacketConn, error) {
	t.Helper()

	server := netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), uint16(port)).String() //nolint:gosec // a bound port.

	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: server,
		TURNServerAddr: server,
		Username:       username,
		Password:       password,
		Conn:           listenUDP(t, "127.0.0.1:0"),
	})
	if err != nil {
		t.Fatalf("turn client: %v", err)
	}

	t.Cleanup(client.Close)

	err = client.Listen()
	if err != nil {
		t.Fatalf("turn client listen: %v", err)
	}

	conn, err := client.Allocate()
	if err != nil {
		return nil, err //nolint:wrapcheck // the caller asserts on the TURN error itself.
	}

	t.Cleanup(func() { _ = conn.Close() })

	return conn, nil
}

func read(t *testing.T, conn net.PacketConn) ([]byte, net.Addr) {
	t.Helper()

	err := conn.SetReadDeadline(time.Now().Add(readTimeout))
	if err != nil {
		t.Fatal(err)
	}

	buf := make([]byte, 1500)

	n, from, err := conn.ReadFrom(buf)
	if err != nil {
		t.Fatalf("read on %s: %v", conn.LocalAddr(), err)
	}

	return buf[:n], from
}

func assertSilent(t *testing.T, conn net.PacketConn) {
	t.Helper()

	err := conn.SetReadDeadline(time.Now().Add(quietPeriod))
	if err != nil {
		t.Fatal(err)
	}

	buf := make([]byte, 1500)

	n, from, err := conn.ReadFrom(buf)
	if err == nil {
		t.Fatalf("%s received %q from %s through the relay", conn.LocalAddr(), buf[:n], from)
	}
}

func TestICEServers(t *testing.T) {
	t.Parallel()

	plain, err := relay.NewCredentials(relay.Config{Port: 3478, TLSHost: ""})
	if err != nil {
		t.Fatal(err)
	}

	withTLS, err := relay.NewCredentials(relay.Config{Port: 3478, TLSHost: "turn.example.com"})
	if err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name  string
		creds *relay.Credentials
		host  string
		want  []string
	}{
		{
			name: "hostname", creds: plain, host: "meet.example.com",
			want: []string{"turn:meet.example.com:3478?transport=udp", "turn:meet.example.com:3478?transport=tcp"},
		},
		{
			name: "ipv6 literal", creds: plain, host: "2001:db8::1",
			want: []string{"turn:[2001:db8::1]:3478?transport=udp", "turn:[2001:db8::1]:3478?transport=tcp"},
		},
		{
			name: "tls host", creds: withTLS, host: "meet.example.com",
			want: []string{
				"turn:meet.example.com:3478?transport=udp",
				"turn:meet.example.com:3478?transport=tcp",
				"turns:turn.example.com:443?transport=tcp",
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			servers := tc.creds.ICEServers(tc.host, member)
			if len(servers) != 1 {
				t.Fatalf("got %d servers", len(servers))
			}

			if strings.Join(servers[0].URLs, " ") != strings.Join(tc.want, " ") {
				t.Fatalf("URLs %v, want %v", servers[0].URLs, tc.want)
			}

			if servers[0].Username != member || servers[0].Credential == "" {
				t.Fatalf("credentials %q/%q", servers[0].Username, servers[0].Credential)
			}
		})
	}

	if plain.ICEServers("h", member)[0].Credential == withTLS.ICEServers("h", member)[0].Credential {
		t.Fatal("two credential sets share a secret")
	}

	if plain.ICEServers("h", member)[0].Credential == plain.ICEServers("h", stranger)[0].Credential {
		t.Fatal("two members share a password")
	}
}

// TestRelayReachesSFU allocates as a member and exchanges packets with
// the SFU's announced address, which the relay delivers to the local
// socket behind it.
func TestRelayReachesSFU(t *testing.T) {
	t.Parallel()

	sfu := listenUDP(t, "127.0.0.1:0")
	announced := netip.MustParseAddrPort("203.0.113.10:5000")
	port, server := startRelay(t, []relay.MediaAddr{{Announced: announced, Local: addrPort(t, sfu.LocalAddr())}})

	conn, err := allocate(t, port, server.Username, server.Credential)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}

	_, err = conn.WriteTo([]byte("ping"), net.UDPAddrFromAddrPort(announced))
	if err != nil {
		t.Fatalf("write to SFU: %v", err)
	}

	payload, relayAddr := read(t, sfu)
	if !bytes.Equal(payload, []byte("ping")) {
		t.Fatalf("SFU got %q", payload)
	}

	_, err = sfu.WriteTo([]byte("pong"), relayAddr)
	if err != nil {
		t.Fatalf("SFU reply: %v", err)
	}

	payload, from := read(t, conn)
	if !bytes.Equal(payload, []byte("pong")) || addrPort(t, from) != announced {
		t.Fatalf("client got %q from %s, want pong from %s", payload, from, announced)
	}
}

// TestRelayOnlyReachesSFU checks that the relay is no open proxy: a
// different port on the SFU's own IP and any other IP get nothing.
func TestRelayOnlyReachesSFU(t *testing.T) {
	t.Parallel()

	sfu := listenUDP(t, "127.0.0.1:0")
	sameIP := listenUDP(t, "127.0.0.1:0")
	otherIP := listenUDP(t, "127.0.0.2:0")
	local := addrPort(t, sfu.LocalAddr())
	port, server := startRelay(t, []relay.MediaAddr{{Announced: local, Local: local}})

	conn, err := allocate(t, port, server.Username, server.Credential)
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}

	for _, target := range []net.PacketConn{sameIP, otherIP} {
		_, _ = conn.WriteTo([]byte("probe"), target.LocalAddr())
	}

	assertSilent(t, sameIP)
	assertSilent(t, otherIP)

	_, err = conn.WriteTo([]byte("ping"), sfu.LocalAddr())
	if err != nil {
		t.Fatalf("write to SFU: %v", err)
	}

	payload, _ := read(t, sfu)
	if !bytes.Equal(payload, []byte("ping")) {
		t.Fatalf("SFU got %q", payload)
	}
}

func TestRelayRejectsNonMembers(t *testing.T) {
	t.Parallel()

	sfu := listenUDP(t, "127.0.0.1:0")
	local := addrPort(t, sfu.LocalAddr())
	port, server := startRelay(t, []relay.MediaAddr{{Announced: local, Local: local}})

	_, err := allocate(t, port, stranger, server.Credential)
	if err == nil {
		t.Fatal("a non-member allocated a relay")
	}

	_, err = allocate(t, port, member, server.Credential+"x")
	if err == nil {
		t.Fatal("a wrong password allocated a relay")
	}
}

func TestStartRequiresMediaAddrs(t *testing.T) {
	t.Parallel()

	creds, err := relay.NewCredentials(relay.Config{Port: freeTURNPort(t), TLSHost: ""})
	if err != nil {
		t.Fatal(err)
	}

	_, err = relay.Start(t.Context(), creds, nil, func(string) bool { return true })
	if err == nil {
		t.Fatal("started a relay with nothing to relay to")
	}
}
