package sfu

import (
	"strings"
	"testing"
)

// TestFingerprintNamesTheSSRCOfEverySection reads a description of two
// sending sections and an inactive one and checks that each sending
// section is logged with its own SSRC, not only the first.
func TestFingerprintNamesTheSSRCOfEverySection(t *testing.T) {
	t.Parallel()

	sdp := strings.Join([]string{
		"v=0",
		"m=audio 9 UDP/TLS/RTP/SAVPF 111",
		"a=mid:0",
		"a=sendonly",
		"a=ssrc:1111 cname:a",
		"a=ssrc:1111 msid:a b",
		"m=video 9 UDP/TLS/RTP/SAVPF 96",
		"a=mid:1",
		"a=inactive",
		"m=video 9 UDP/TLS/RTP/SAVPF 96",
		"a=mid:2",
		"a=sendonly",
		"a=ssrc:2222 cname:a",
		"",
	}, "\r\n")

	want := "audio 9 UDP/TLS/RTP/SAVPF 111 mid=0 sendonly ssrc=1111; " +
		"video 9 UDP/TLS/RTP/SAVPF 96 mid=1 inactive; " +
		"video 9 UDP/TLS/RTP/SAVPF 96 mid=2 sendonly ssrc=2222"

	if got := sdpFingerprint(sdp); got != want {
		t.Fatalf("fingerprint\n got %s\nwant %s", got, want)
	}
}
