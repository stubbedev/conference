package sfu

import (
	"encoding/json"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func matchesFixture(t *testing.T, name string, written any) {
	t.Helper()

	want, err := json.MarshalIndent(written, "", "  ")
	if err != nil {
		t.Fatalf("encode %s: %v", name, err)
	}

	data, err := fs.ReadFile(os.DirFS(filepath.Join("..", "..", "fixtures")), name)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	var fixture, server any

	err = json.Unmarshal(data, &fixture)
	if err != nil {
		t.Fatalf("decode fixture %s: %v", name, err)
	}

	err = json.Unmarshal(want, &server)
	if err != nil {
		t.Fatalf("decode %s as the server writes it: %v", name, err)
	}

	if !reflect.DeepEqual(fixture, server) {
		t.Errorf("fixtures/%s is not what the server writes, which is:\n%s", name, want)
	}
}
