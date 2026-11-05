package token_test

import (
	"testing"
	"time"

	"github.com/stubbe/conference/internal/speech/token"
)

const (
	secret = "secret"
	vector = "eyJyb29tIjoicm9vbSIsIm1lbWJlciI6Im1lbWJlciIsImV4cCI6MTAwMDAwMzYwMH0.-ycrBJy64UzIbCMPyi4X5xLG1BlcZ0sZD-da7aA6ywY"
)

func testClaims() token.Claims {
	return token.Claims{Room: "room", Member: "member", Exp: 1_000_003_600}
}

func TestMintMatchesVector(t *testing.T) {
	t.Parallel()

	got, err := token.Mint([]byte(secret), testClaims())
	if err != nil {
		t.Fatalf("mint: %v", err)
	}

	if got != vector {
		t.Fatalf("token %q, want %q", got, vector)
	}
}

func TestVerify(t *testing.T) {
	t.Parallel()

	claims := testClaims()
	valid := time.Unix(claims.Exp, 0)

	cases := []struct {
		name   string
		secret string
		token  string
		now    time.Time
		ok     bool
	}{
		{name: "valid until its expiry", secret: secret, token: vector, now: valid, ok: true},
		{name: "expired", secret: secret, token: vector, now: valid.Add(time.Second), ok: false},
		{name: "other secret", secret: "other", token: vector, now: valid, ok: false},
		{name: "tampered payload", secret: secret, token: "x" + vector, now: valid, ok: false},
		{name: "no signature", secret: secret, token: "payload", now: valid, ok: false},
		{name: "empty", secret: secret, token: "", now: valid, ok: false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			got, err := token.Verify([]byte(tc.secret), tc.token, tc.now)
			if tc.ok != (err == nil) {
				t.Fatalf("verify error %v, want ok=%v", err, tc.ok)
			}

			if tc.ok && got != claims {
				t.Fatalf("claims %+v, want %+v", got, claims)
			}
		})
	}
}
