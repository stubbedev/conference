package config_test

import (
	"net/netip"
	"slices"
	"testing"

	"github.com/stubbe/conference/internal/config"
)

func TestOpenCreateHosts(t *testing.T) {
	t.Setenv("OPEN_CREATE_HOSTS", " Stubbe.DEV, mariabugge.com ")

	cfg, err := config.FromEnv()
	if err != nil {
		t.Fatal(err)
	}

	want := []string{"stubbe.dev", "mariabugge.com"}
	if !slices.Equal(cfg.OpenCreateHosts, want) {
		t.Fatalf("got %v, want %v", cfg.OpenCreateHosts, want)
	}
}

func TestOpenCreateHostsDefault(t *testing.T) {
	t.Parallel()

	cfg, err := config.FromEnv()
	if err != nil {
		t.Fatal(err)
	}

	if cfg.OpenCreateHosts != nil {
		t.Fatalf("got %v, want nil", cfg.OpenCreateHosts)
	}
}

func TestMediaDefaults(t *testing.T) {
	t.Parallel()

	cfg, err := config.FromEnv()
	if err != nil {
		t.Fatal(err)
	}

	if cfg.ICEUDPPort != 5000 || cfg.Relay.Port != 3478 || cfg.Relay.TLSHost != "" || cfg.ExternalIPs != nil {
		t.Fatalf("got ice %d, turn %+v, external %v", cfg.ICEUDPPort, cfg.Relay, cfg.ExternalIPs)
	}
}

func TestExternalIPs(t *testing.T) {
	t.Setenv("EXTERNAL_IPS", "203.0.113.10, 2001:db8::1")
	t.Setenv("TURN_TLS_HOST", "turn.example.com")

	cfg, err := config.FromEnv()
	if err != nil {
		t.Fatal(err)
	}

	want := []netip.Addr{netip.MustParseAddr("203.0.113.10"), netip.MustParseAddr("2001:db8::1")}
	if !slices.Equal(cfg.ExternalIPs, want) {
		t.Fatalf("got %v, want %v", cfg.ExternalIPs, want)
	}

	if cfg.Relay.TLSHost != "turn.example.com" {
		t.Fatalf("got TLS host %q", cfg.Relay.TLSHost)
	}
}

func TestMediaConfigRejects(t *testing.T) {
	for _, tc := range []struct {
		name string
		env  map[string]string
	}{
		{name: "hostname as external IP", env: map[string]string{"EXTERNAL_IPS": "meet.example.com"}},
		{name: "ephemeral ICE port", env: map[string]string{"ICE_UDP_PORT": "0"}},
		{name: "ICE port out of range", env: map[string]string{"ICE_UDP_PORT": "70000"}},
		{name: "negative TURN port", env: map[string]string{"TURN_PORT": "-1"}},
		{name: "TURN on the ICE port", env: map[string]string{"TURN_PORT": "5000"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for key, value := range tc.env {
				t.Setenv(key, value)
			}

			_, err := config.FromEnv()
			if err == nil {
				t.Fatalf("accepted %v", tc.env)
			}
		})
	}
}
