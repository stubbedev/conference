package config_test

import (
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
