// Package relay is the embedded TURN server. It lets members whose
// network blocks direct UDP to the SFU (UDP-hostile firewalls, TCP-only
// or TLS-only egress) reach it through TURN over UDP, TCP or TLS.
//
// The relay only ever forwards to the SFU's own ICE address: relay
// sockets bind next to the SFU's UDP mux, translate the SFU's announced
// address to its local socket in-process (no hairpin through NAT or
// Docker port publishing) and drop every other peer. Credentials are
// bound to a live call member and stop working when the member leaves.
//
// The relay's UDP sockets carry the same bursts of video as the SFU's
// and are sized like them: the listening socket, which every member
// relaying over UDP sends to, and the relay socket of each allocation,
// which the SFU sends that member's video to. TURN over TCP needs none
// of it: a full buffer there holds the sender back and drops nothing.
package relay

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"syscall"

	"github.com/pion/turn/v5"

	"github.com/stubbe/conference/internal/recvbuf"
)

const (
	realm       = "conference"
	secretBytes = 32
	tlsPort     = "443"
)

var (
	errNoMediaAddrs  = errors.New("relay: the SFU announces no addresses to relay to")
	errTCPRelay      = errors.New("relay: TCP relay allocations are not supported")
	errNotSFU        = errors.New("relay: peer is not the SFU")
	errNoFamily      = errors.New("relay: the SFU has no address in the requested family")
	errNotUDPAddress = errors.New("relay: not a UDP address")
	errNoPickedPort  = errors.New("relay: no port the kernel picked was free over both UDP and TCP")
)

// Config locates the TURN listeners.
type Config struct {
	// Port is the UDP and TCP port TURN listens on; 0 lets the kernel
	// pick one.
	Port int

	// TLSHost, when set, is a hostname whose port 443 terminates TLS
	// and forwards the plain TCP stream to Port (e.g. a traefik TCP
	// router). Members then also get a turns: URL, the only transport
	// that crosses TLS-only egress.
	TLSHost string
}

// ICEServer mirrors the WebRTC RTCIceServer dictionary sent to members.
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username"`
	Credential string   `json:"credential"`
}

// MediaAddr pairs an address the SFU announces in its ICE candidates
// with the local socket that receives traffic sent to it.
type MediaAddr struct {
	Announced netip.AddrPort
	Local     netip.AddrPort
}

// Credentials mints TURN credentials: the username is a member ID and
// the password an HMAC of it under a secret that lives only in this
// process.
type Credentials struct {
	cfg    Config
	secret []byte
}

// NewCredentials creates a fresh process-local secret.
func NewCredentials(cfg Config) (*Credentials, error) {
	secret := make([]byte, secretBytes)

	_, err := rand.Read(secret)
	if err != nil {
		return nil, fmt.Errorf("relay: generate secret: %w", err)
	}

	return &Credentials{cfg: cfg, secret: secret}, nil
}

// ICEServers returns the TURN servers for one member. host is the
// hostname the member reached the signaling endpoint on, which
// therefore resolves to this server.
func (c *Credentials) ICEServers(host, memberID string) []ICEServer {
	addr := net.JoinHostPort(host, strconv.Itoa(c.cfg.Port))
	urls := []string{
		"turn:" + addr + "?transport=udp",
		"turn:" + addr + "?transport=tcp",
	}

	if c.cfg.TLSHost != "" {
		urls = append(urls, "turns:"+net.JoinHostPort(c.cfg.TLSHost, tlsPort)+"?transport=tcp")
	}

	return []ICEServer{{URLs: urls, Username: memberID, Credential: c.password(memberID)}}
}

func (c *Credentials) password(username string) string {
	mac := hmac.New(sha256.New, c.secret)
	_, _ = mac.Write([]byte(username))

	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// Listener holds the TURN sockets, bound before the server runs so that
// the credentials it hands out name the port it really got.
type Listener struct {
	packet  net.PacketConn
	stream  net.Listener
	sockets *recvbuf.Sizer
	creds   *Credentials
}

// Listen binds UDP and TCP, dual-stack, on cfg.Port, or on one port the
// kernel picks for both when cfg.Port is 0. Its UDP sockets are sized by
// sockets.
func Listen(ctx context.Context, cfg Config, sockets *recvbuf.Sizer) (*Listener, error) {
	packet, stream, port, err := listenPair(ctx, sockets, cfg.Port)
	if err != nil {
		return nil, err
	}

	listener := &Listener{packet: packet, stream: stream, sockets: sockets, creds: nil}

	listener.creds, err = NewCredentials(Config{Port: port, TLSHost: cfg.TLSHost})
	if err != nil {
		_ = listener.Close()

		return nil, err
	}

	return listener, nil
}

// Close releases the sockets of a listener that is not served.
func (l *Listener) Close() error {
	err := errors.Join(l.packet.Close(), l.stream.Close())
	if err != nil {
		return fmt.Errorf("relay: close listener %s: %w", l.stream.Addr(), err)
	}

	return nil
}

// Port is the UDP and TCP port the listener is bound to.
func (l *Listener) Port() int {
	return l.creds.cfg.Port
}

// Credentials mints the credentials for this listener's port.
func (l *Listener) Credentials() *Credentials {
	return l.creds
}

const pickedPortAttempts = 8

func listenPair(ctx context.Context, sockets *recvbuf.Sizer, port int) (net.PacketConn, net.Listener, int, error) {
	if port != 0 {
		return bindPair(ctx, sockets, port)
	}

	for range pickedPortAttempts {
		packet, stream, picked, err := bindPair(ctx, sockets, 0)
		if !errors.Is(err, syscall.EADDRINUSE) {
			return packet, stream, picked, err
		}
	}

	return nil, nil, 0, fmt.Errorf("%w after %d attempts", errNoPickedPort, pickedPortAttempts)
}

func bindPair(ctx context.Context, sockets *recvbuf.Sizer, port int) (net.PacketConn, net.Listener, int, error) {
	packet, err := listenMedia(ctx, sockets, "udp", net.JoinHostPort("", strconv.Itoa(port)))
	if err != nil {
		return nil, nil, 0, err
	}

	local, err := addrPort(packet.LocalAddr())
	if err != nil {
		_ = packet.Close()

		return nil, nil, 0, err
	}

	addr := net.JoinHostPort("", strconv.Itoa(int(local.Port())))

	var listenConfig net.ListenConfig

	stream, err := listenConfig.Listen(ctx, "tcp", addr)
	if err != nil {
		_ = packet.Close()

		return nil, nil, 0, fmt.Errorf("relay: listen tcp %s: %w", addr, err)
	}

	return packet, stream, int(local.Port()), nil
}

// Server is a running TURN server.
type Server struct {
	turn *turn.Server
}

// Serve runs the TURN server on the listener's sockets and relays to
// media only. live reports whether a member ID belongs to a member
// currently in a call; every TURN request re-checks it. On failure the
// listener is closed.
func (l *Listener) Serve(media []MediaAddr, live func(memberID string) bool) (*Server, error) {
	server, err := l.serve(media, live)
	if err != nil {
		_ = l.Close()

		return nil, err
	}

	return server, nil
}

func (l *Listener) serve(media []MediaAddr, live func(memberID string) bool) (*Server, error) {
	relays, err := newSFURelay(media, l.sockets)
	if err != nil {
		return nil, err
	}

	server, err := turn.NewServer(turn.ServerConfig{
		Realm: realm,
		AuthHandler: func(attrs *turn.RequestAttributes) (string, []byte, bool) {
			if !live(attrs.Username) {
				return "", nil, false
			}

			key := turn.GenerateAuthKey(attrs.Username, attrs.Realm, l.creds.password(attrs.Username))

			return attrs.Username, key, true
		},
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn:            l.packet,
			RelayAddressGenerator: relays,
			PermissionHandler:     relays.permits,
		}},
		ListenerConfigs: []turn.ListenerConfig{{
			Listener:              l.stream,
			RelayAddressGenerator: relays,
			PermissionHandler:     relays.permits,
		}},
	})
	if err != nil {
		return nil, fmt.Errorf("relay: start turn on port %d: %w", l.Port(), err)
	}

	return &Server{turn: server}, nil
}

// Close stops the listeners and every allocation.
func (s *Server) Close() error {
	err := s.turn.Close()
	if err != nil {
		return fmt.Errorf("relay: close: %w", err)
	}

	return nil
}

// listenMedia opens a UDP socket media arrives on, sized for a burst of
// it.
func listenMedia(ctx context.Context, sockets *recvbuf.Sizer, network, addr string) (net.PacketConn, error) {
	var listenConfig net.ListenConfig

	conn, err := listenConfig.ListenPacket(ctx, network, addr)
	if err != nil {
		return nil, fmt.Errorf("relay: listen %s %s: %w", network, addr, err)
	}

	err = sockets.Size(conn)
	if err != nil {
		_ = conn.Close()

		return nil, fmt.Errorf("relay: %w", err)
	}

	return conn, nil
}

// sfuRelay allocates relay sockets that can only talk to the SFU.
type sfuRelay struct {
	sockets     *recvbuf.Sizer
	toLocal     map[netip.AddrPort]netip.AddrPort
	toAnnounced map[netip.AddrPort]netip.AddrPort
	announced   map[netip.Addr]bool
	bind        map[string]netip.Addr
}

func newSFURelay(media []MediaAddr, sockets *recvbuf.Sizer) (*sfuRelay, error) {
	if len(media) == 0 {
		return nil, errNoMediaAddrs
	}

	relays := &sfuRelay{
		sockets:     sockets,
		toLocal:     make(map[netip.AddrPort]netip.AddrPort, len(media)),
		toAnnounced: make(map[netip.AddrPort]netip.AddrPort, len(media)),
		announced:   make(map[netip.Addr]bool, len(media)),
		bind:        map[string]netip.Addr{},
	}

	for _, addr := range media {
		relays.toLocal[addr.Announced] = addr.Local
		relays.toAnnounced[addr.Local] = addr.Announced
		relays.announced[addr.Announced.Addr()] = true

		network := udpNetwork(addr.Local.Addr())
		if _, ok := relays.bind[network]; !ok {
			relays.bind[network] = addr.Local.Addr()
		}
	}

	return relays, nil
}

func udpNetwork(addr netip.Addr) string {
	if addr.Is4() {
		return "udp4"
	}

	return "udp6"
}

// Validate implements turn.RelayAddressGenerator.
func (r *sfuRelay) Validate() error {
	return nil
}

// AllocatePacketConn binds the relay socket on the SFU's local address
// of the requested family and reports that address as the relay
// address: the SFU reaches it by local delivery.
func (r *sfuRelay) AllocatePacketConn(conf turn.AllocateListenerConfig) (net.PacketConn, net.Addr, error) {
	bind, ok := r.bind[conf.Network]
	if !ok {
		return nil, nil, fmt.Errorf("%w: %s", errNoFamily, conf.Network)
	}

	addr := netip.AddrPortFrom(bind, uint16(conf.RequestedPort)) //nolint:gosec // pion validates the requested port.

	conn, err := listenMedia(context.Background(), r.sockets, conf.Network, addr.String())
	if err != nil {
		return nil, nil, err
	}

	return &sfuConn{PacketConn: conn, relays: r}, conn.LocalAddr(), nil
}

// AllocateListener implements turn.RelayAddressGenerator. Browsers only
// request UDP relays (RFC 6062 TCP allocations are not used by WebRTC).
func (r *sfuRelay) AllocateListener(turn.AllocateListenerConfig) (net.Listener, net.Addr, error) {
	return nil, nil, errTCPRelay
}

// AllocateConn implements turn.RelayAddressGenerator.
func (r *sfuRelay) AllocateConn(turn.AllocateConnConfig) (net.Conn, error) {
	return nil, errTCPRelay
}

func (r *sfuRelay) permits(_ net.Addr, peer net.IP) bool {
	addr, ok := netip.AddrFromSlice(peer)

	return ok && r.announced[addr.Unmap()]
}

// sfuConn is a relay socket that exchanges packets with the SFU only,
// translating between its announced and local addresses.
type sfuConn struct {
	net.PacketConn

	relays *sfuRelay
}

func (c *sfuConn) WriteTo(payload []byte, addr net.Addr) (int, error) {
	peer, err := addrPort(addr)
	if err != nil {
		return 0, err
	}

	local, ok := c.relays.toLocal[peer]
	if !ok {
		return 0, fmt.Errorf("%w: %s", errNotSFU, peer)
	}

	n, err := c.PacketConn.WriteTo(payload, net.UDPAddrFromAddrPort(local))
	if err != nil {
		return n, fmt.Errorf("relay: write to SFU %s: %w", local, err)
	}

	return n, nil
}

func (c *sfuConn) ReadFrom(payload []byte) (int, net.Addr, error) {
	for {
		read, addr, err := c.PacketConn.ReadFrom(payload)
		if err != nil {
			return read, addr, fmt.Errorf("relay: read: %w", err)
		}

		source, parseErr := addrPort(addr)
		if parseErr != nil {
			continue
		}

		announced, ok := c.relays.toAnnounced[source]
		if !ok {
			continue
		}

		return read, net.UDPAddrFromAddrPort(announced), nil
	}
}

func addrPort(addr net.Addr) (netip.AddrPort, error) {
	udp, ok := addr.(*net.UDPAddr)
	if !ok {
		return netip.AddrPort{}, fmt.Errorf("%w: %v", errNotUDPAddress, addr)
	}

	peer := udp.AddrPort()

	return netip.AddrPortFrom(peer.Addr().Unmap(), peer.Port()), nil
}
