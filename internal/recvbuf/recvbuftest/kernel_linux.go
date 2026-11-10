package recvbuftest

import (
	"os"
	"strconv"
	"strings"
	"testing"
)

// SkipUnlessGranted skips the test on a kernel that grants a socket
// asking for a receive buffer of bytes less than that: there a media
// socket holds no more than a default one.
func SkipUnlessGranted(t *testing.T, bytes int) {
	t.Helper()

	const setting = "/proc/sys/net/core/rmem_max"

	raw, err := os.ReadFile(setting)
	if err != nil {
		t.Fatalf("read %s: %v", setting, err)
	}

	limit, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatalf("parse %s: %v", setting, err)
	}

	if limit < bytes {
		t.Skipf("this kernel caps receive buffers at %d bytes, below the %d asked for", limit, bytes)
	}
}
