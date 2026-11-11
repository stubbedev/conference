// Package config loads server configuration from environment variables.
package config

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/stubbe/conference/internal/relay"
)

// Defaults, overridable through the environment.
const (
	defaultHTTPPort       = 8080
	defaultDBPath         = "conference.db"
	defaultICEUDPPort     = 5000
	defaultTURNPort       = 3478
	maxPort               = 65535
	defaultMaxRoomMembers = 16
	defaultRoomTTLDays    = 365
	defaultSessionDays    = 365
	hoursPerDay           = 24
)

// Config is the complete server configuration.
type Config struct {
	HTTPAddr string // listen address for HTTP/WebSocket
	BaseURL  string // public origin, e.g. https://meet.example.com (optional; always scheme://host when set)

	// PublicOrigins are further scheme://host origins the same server
	// answers on. Requests arriving on one of them get links and preview
	// URLs on that origin instead of BaseURL.
	PublicOrigins []string

	DBPath string // SQLite database path

	// APIKeys authenticate room creation/deletion. When empty, room
	// creation is open (single-operator self-hosting). Rooms themselves
	// are immutable once created; the key holder can only delete them.
	APIKeys []string

	// JoinOnly hides the create form on the landing page: the public can
	// only join, rooms come in through the API. Requires APIKeys, since
	// without a key creation would stay open to everyone anyway.
	JoinOnly bool

	// SlackSigningSecret enables the Slack slash command endpoint and
	// authenticates its requests. Empty disables it; set, it requires
	// BaseURL, since Slack messages need absolute links.
	SlackSigningSecret string

	// OpenCreateHosts lists hostnames where room creation stays open
	// (no API key, create form visible) even though APIKeys/JoinOnly
	// restrict the other domains served by the same process.
	OpenCreateHosts []string

	ICEUDPPort  int          // UDP port of the ICE mux; 0 lets the kernel pick
	ExternalIPs []netip.Addr // NAT 1:1 addresses announced as host candidates
	Relay       relay.Config // embedded TURN server

	// TrustedProxies are the reverse proxies whose X-Forwarded-For
	// header names the real client. Empty trusts no header: the client
	// is the TCP peer.
	TrustedProxies []netip.Prefix

	// AllowedOrigins overrides the same-origin WebSocket check when
	// non-empty. Empty means the Origin header must match the Host.
	AllowedOrigins []string

	SessionTTL     time.Duration // authenticated room sessions
	MaxRoomMembers int           // 0 means unlimited
	RoomTTL        time.Duration // rooms unjoined for this long are reaped; 0 = keep forever
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}

	return def
}

func envInt(key string, def int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}

	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", key, err)
	}

	return n, nil
}

// envPort reads a port to bind: 1-65535, or 0 for one the kernel picks.
func envPort(key string, def int) (int, error) {
	port, err := envInt(key, def)
	if err != nil {
		return 0, err
	}

	if port < 0 || port > maxPort {
		return 0, fmt.Errorf("%w: %s=%d", errPortRange, key, port)
	}

	return port, nil
}

func envBool(key string) bool {
	switch strings.ToLower(os.Getenv(key)) {
	case "1", "true", "yes":
		return true
	default:
		return false
	}
}

func splitList(v string) []string {
	var out []string

	for part := range strings.SplitSeq(v, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}

		out = append(out, part)
	}

	return out
}

var (
	errPortRange = errors.New("port out of range 0-65535")
	errPortClash = errors.New("ports must differ")
	errOrigin    = errors.New("must be an http(s) origin such as https://meet.example.com, with no path, query or fragment")
)

var (
	errJoinOnlyNeedsKey  = errors.New("JOIN_ONLY requires API_KEYS; without a key, room creation stays open to everyone")
	errOriginsNeedBase   = errors.New("PUBLIC_ORIGINS requires BASE_URL, the origin used when a request matches none of them")
	errSlackNeedsBaseURL = errors.New("SLACK_SIGNING_SECRET requires BASE_URL; Slack messages need absolute room links")
)

// FromEnv builds a Config from the process environment.
func FromEnv() (*Config, error) {
	cfg := &Config{
		HTTPAddr:           "",
		BaseURL:            "",
		PublicOrigins:      nil,
		DBPath:             env("DB_PATH", defaultDBPath),
		APIKeys:            nil,
		JoinOnly:           false,
		SlackSigningSecret: "",
		OpenCreateHosts:    nil,
		ICEUDPPort:         defaultICEUDPPort,
		ExternalIPs:        nil,
		Relay:              relay.Config{Port: defaultTURNPort, TLSHost: ""},
		TrustedProxies:     nil,
		AllowedOrigins:     nil,
		SessionTTL:         defaultSessionDays * hoursPerDay * time.Hour,
		MaxRoomMembers:     defaultMaxRoomMembers,
		RoomTTL:            0,
	}

	err := applyHTTPConfig(cfg)
	if err != nil {
		return nil, err
	}

	err = applyMediaConfig(cfg)
	if err != nil {
		return nil, err
	}

	err = applyRoomConfig(cfg)
	if err != nil {
		return nil, err
	}

	if cfg.JoinOnly && len(cfg.APIKeys) == 0 {
		return nil, errJoinOnlyNeedsKey
	}

	if len(cfg.PublicOrigins) > 0 && cfg.BaseURL == "" {
		return nil, errOriginsNeedBase
	}

	if cfg.SlackSigningSecret != "" && cfg.BaseURL == "" {
		return nil, errSlackNeedsBaseURL
	}

	return cfg, nil
}

// applyHTTPConfig fills the addressing and authentication settings.
func applyHTTPConfig(cfg *Config) error {
	port, err := envPort("PORT", defaultHTTPPort)
	if err != nil {
		return err
	}

	cfg.HTTPAddr = net.JoinHostPort(env("BIND", ""), strconv.Itoa(port))

	cfg.BaseURL, err = parseOrigin(env("BASE_URL", ""))
	if err != nil {
		return fmt.Errorf("BASE_URL: %w", err)
	}

	for _, raw := range splitList(env("PUBLIC_ORIGINS", "")) {
		origin, err := parseOrigin(raw)
		if err != nil {
			return fmt.Errorf("PUBLIC_ORIGINS: %w", err)
		}

		cfg.PublicOrigins = append(cfg.PublicOrigins, origin)
	}

	cfg.APIKeys = splitList(env("API_KEYS", ""))
	cfg.JoinOnly = envBool("JOIN_ONLY")
	cfg.SlackSigningSecret = env("SLACK_SIGNING_SECRET", "")

	for _, host := range splitList(env("OPEN_CREATE_HOSTS", "")) {
		cfg.OpenCreateHosts = append(cfg.OpenCreateHosts, strings.ToLower(host))
	}

	cfg.AllowedOrigins = splitList(env("ALLOWED_ORIGINS", ""))

	for _, raw := range splitList(env("TRUSTED_PROXIES", "")) {
		proxy, err := parsePrefix(raw)
		if err != nil {
			return fmt.Errorf("TRUSTED_PROXIES: %w", err)
		}

		cfg.TrustedProxies = append(cfg.TrustedProxies, proxy)
	}

	return nil
}

// parseOrigin validates raw as an http(s) origin and returns it as
// scheme://host. An empty raw means "not configured".
func parseOrigin(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}

	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("%w: %q: %w", errOrigin, raw, err)
	}

	validScheme := parsed.Scheme == "http" || parsed.Scheme == "https"
	bare := strings.TrimSuffix(parsed.Path, "/") == "" && parsed.RawQuery == "" && parsed.Fragment == "" && parsed.User == nil

	if !validScheme || parsed.Host == "" || !bare {
		return "", fmt.Errorf("%w: got %q", errOrigin, raw)
	}

	return parsed.Scheme + "://" + strings.ToLower(parsed.Host), nil
}

// parsePrefix accepts a CIDR prefix or a single address.
func parsePrefix(raw string) (netip.Prefix, error) {
	if strings.Contains(raw, "/") {
		prefix, err := netip.ParsePrefix(raw)
		if err != nil {
			return netip.Prefix{}, fmt.Errorf("parse %q: %w", raw, err)
		}

		return prefix.Masked(), nil
	}

	addr, err := netip.ParseAddr(raw)
	if err != nil {
		return netip.Prefix{}, fmt.Errorf("parse %q: %w", raw, err)
	}

	addr = addr.Unmap()

	return netip.PrefixFrom(addr, addr.BitLen()), nil
}

// OriginFor returns the configured origin whose host matches the
// request's Host header, falling back to BaseURL. The Host header only
// selects among configured origins, so it can never inject one.
func (c *Config) OriginFor(hostHeader string) string {
	for _, origin := range c.PublicOrigins {
		if strings.EqualFold(originHost(origin), hostHeader) {
			return origin
		}
	}

	return c.BaseURL
}

// Origins lists BaseURL followed by PublicOrigins; empty when no
// BaseURL is configured.
func (c *Config) Origins() []string {
	if c.BaseURL == "" {
		return nil
	}

	return append([]string{c.BaseURL}, c.PublicOrigins...)
}

func originHost(origin string) string {
	_, host, _ := strings.Cut(origin, "://")

	return host
}

// applyMediaConfig fills the WebRTC settings.
func applyMediaConfig(cfg *Config) error {
	udpPort, err := envPort("ICE_UDP_PORT", defaultICEUDPPort)
	if err != nil {
		return err
	}

	turnPort, err := envPort("TURN_PORT", defaultTURNPort)
	if err != nil {
		return err
	}

	if turnPort != 0 && turnPort == udpPort {
		return fmt.Errorf("%w: TURN_PORT and ICE_UDP_PORT are both %d", errPortClash, udpPort)
	}

	cfg.ICEUDPPort = udpPort
	cfg.Relay = relay.Config{Port: turnPort, TLSHost: env("TURN_TLS_HOST", "")}

	for _, raw := range splitList(env("EXTERNAL_IPS", "")) {
		addr, parseErr := netip.ParseAddr(raw)
		if parseErr != nil {
			return fmt.Errorf("EXTERNAL_IPS: %w", parseErr)
		}

		cfg.ExternalIPs = append(cfg.ExternalIPs, addr.Unmap())
	}

	return nil
}

// applyRoomConfig fills the room limit and reap settings.
func applyRoomConfig(cfg *Config) error {
	maxRoomMembers, err := envInt("MAX_ROOM_MEMBERS", cfg.MaxRoomMembers)
	if err != nil {
		return err
	}

	if maxRoomMembers > 0 {
		cfg.MaxRoomMembers = maxRoomMembers
	}

	roomTTLDays, err := envInt("ROOM_TTL_DAYS", defaultRoomTTLDays)
	if err != nil {
		return err
	}

	if roomTTLDays > 0 {
		cfg.RoomTTL = time.Duration(roomTTLDays) * hoursPerDay * time.Hour
	}

	return nil
}
