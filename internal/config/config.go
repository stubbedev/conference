// Package config loads server configuration from environment variables.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
)

// Defaults, overridable through the environment.
const (
	defaultHTTPPort       = "8080"
	defaultDBPath         = "conference.db"
	defaultICEUDPPort     = 5000
	defaultMaxPublishKbps = 2500
	defaultMaxRoomMembers = 16
	defaultRoomTTLDays    = 365
	defaultSessionDays    = 365
	hoursPerDay           = 24
)

// ICEServer mirrors the WebRTC ICEServer dictionary exposed to browsers
// via GET /api/config. TURN credentials may reference time-limited
// credentials computed by the operator; no secrets are generated here.
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// Config is the complete server configuration.
type Config struct {
	HTTPAddr string // listen address for HTTP/WebSocket
	BaseURL  string // public origin, e.g. https://meet.example.com (optional)

	DBPath string // SQLite database path

	// APIKeys authenticate room creation/deletion. When empty, room
	// creation is open (single-operator self-hosting). Rooms themselves
	// are immutable once created; the key holder can only delete them.
	APIKeys []string

	// JoinOnly hides the create form on the landing page: the public can
	// only join, rooms come in through the API. Requires APIKeys, since
	// without a key creation would stay open to everyone anyway.
	JoinOnly bool

	// OpenCreateHosts lists hostnames where room creation stays open
	// (no API key, create form visible) even though APIKeys/JoinOnly
	// restrict the other domains served by the same process.
	OpenCreateHosts []string

	ICEUDPPort  int      // single UDP port for the ICE mux (0 = ephemeral ports)
	ExternalIPs []string // NAT 1:1 addresses announced as host candidates
	ICEServers  []ICEServer

	// Ceiling for the REMB estimate the SFU feeds back to publishers.
	MaxPublishKbps int

	// AllowedOrigins overrides the same-origin WebSocket check when
	// non-empty. Empty means the Origin header must match the Host.
	AllowedOrigins []string

	SessionTTL     time.Duration // authenticated room sessions
	MaxRoomMembers int           // 0 means unlimited
	RoomTTL        time.Duration // rooms older than this are reaped; 0 = keep forever
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

var errJoinOnlyNeedsKey = errors.New("config: JOIN_ONLY requires API_KEYS; without a key, room creation stays open to everyone")

// FromEnv builds a Config from the process environment.
func FromEnv() (*Config, error) {
	cfg := &Config{
		HTTPAddr:        "",
		BaseURL:         "",
		DBPath:          env("DB_PATH", defaultDBPath),
		APIKeys:         nil,
		JoinOnly:        false,
		OpenCreateHosts: nil,
		ICEUDPPort:      defaultICEUDPPort,
		ExternalIPs:     nil,
		ICEServers:      nil,
		MaxPublishKbps:  defaultMaxPublishKbps,
		AllowedOrigins:  nil,
		SessionTTL:      defaultSessionDays * hoursPerDay * time.Hour,
		MaxRoomMembers:  defaultMaxRoomMembers,
		RoomTTL:         0,
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

	return cfg, nil
}

// applyHTTPConfig fills the addressing and authentication settings.
func applyHTTPConfig(cfg *Config) error {
	port := env("PORT", defaultHTTPPort)

	_, err := strconv.Atoi(port)
	if err != nil {
		return fmt.Errorf("PORT: %w", err)
	}

	cfg.HTTPAddr = net.JoinHostPort(env("BIND", ""), port)
	cfg.BaseURL = strings.TrimRight(env("BASE_URL", ""), "/")
	cfg.APIKeys = splitList(env("API_KEYS", ""))
	cfg.JoinOnly = envBool("JOIN_ONLY")

	for _, host := range splitList(env("OPEN_CREATE_HOSTS", "")) {
		cfg.OpenCreateHosts = append(cfg.OpenCreateHosts, strings.ToLower(host))
	}

	cfg.AllowedOrigins = splitList(env("ALLOWED_ORIGINS", ""))

	return nil
}

// applyMediaConfig fills the WebRTC settings.
func applyMediaConfig(cfg *Config) error {
	udpPort, err := envInt("ICE_UDP_PORT", defaultICEUDPPort)
	if err != nil {
		return err
	}

	cfg.ICEUDPPort = udpPort
	cfg.ExternalIPs = splitList(env("EXTERNAL_IPS", ""))

	if iceServers := os.Getenv("ICE_SERVERS"); iceServers != "" {
		err := json.Unmarshal([]byte(iceServers), &cfg.ICEServers)
		if err != nil {
			return fmt.Errorf("ICE_SERVERS: %w", err)
		}
	}

	if cfg.ICEServers == nil {
		cfg.ICEServers = []ICEServer{{
			URLs:       []string{"stun:stun.l.google.com:19302"},
			Username:   "",
			Credential: "",
		}}
	}

	maxPublishKbps, err := envInt("MAX_PUBLISH_KBPS", cfg.MaxPublishKbps)
	if err != nil {
		return err
	}

	if maxPublishKbps > 0 {
		cfg.MaxPublishKbps = maxPublishKbps
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
