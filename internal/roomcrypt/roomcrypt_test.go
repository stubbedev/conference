package roomcrypt_test

import (
	"bytes"
	"crypto/rand"
	"errors"
	"testing"

	"github.com/stubbe/conference/internal/roomcrypt"
)

const (
	saltSize = 16
	slugLen  = 11
)

func testSalt(t *testing.T) []byte {
	t.Helper()

	salt := make([]byte, saltSize)

	_, err := rand.Read(salt)
	if err != nil {
		t.Fatal(err)
	}

	return salt
}

func TestProofRoundTrip(t *testing.T) {
	t.Parallel()

	salt := testSalt(t)

	proof, err := roomcrypt.DeriveProof("hunter2", salt)
	if err != nil {
		t.Fatal(err)
	}

	if len(proof) != roomcrypt.KeyLen {
		t.Fatalf("proof length = %d, want %d", len(proof), roomcrypt.KeyLen)
	}

	again, err := roomcrypt.DeriveProof("hunter2", salt)
	if err != nil {
		t.Fatal(err)
	}

	if !roomcrypt.VerifyProof(proof, again) {
		t.Error("correct proof did not verify")
	}

	wrong, err := roomcrypt.DeriveProof("hunter3", salt)
	if err != nil {
		t.Fatal(err)
	}

	if roomcrypt.VerifyProof(proof, wrong) {
		t.Error("wrong proof verified")
	}
}

func TestKeyblobRoundTrip(t *testing.T) {
	t.Parallel()

	key := roomcrypt.NewKey()
	salt := testSalt(t)

	blob, err := roomcrypt.SealKeyblob(key, "hunter2", salt)
	if err != nil {
		t.Fatal(err)
	}

	got, err := roomcrypt.OpenKeyblob(blob, "hunter2", salt)
	if err != nil {
		t.Fatal(err)
	}

	if !bytes.Equal(got, key) {
		t.Error("recovered key differs")
	}

	_, openErr := roomcrypt.OpenKeyblob(blob, "wrong", salt)
	if !errors.Is(openErr, roomcrypt.ErrBadProof) {
		t.Errorf("wrong password: err = %v, want ErrBadProof", openErr)
	}
}

func TestKeyblobIsServerBlind(t *testing.T) {
	t.Parallel()

	key := roomcrypt.NewKey()

	authSalt, authHash, keySalt, blob, err := roomcrypt.NewPasswordMaterials(key, "hunter2")
	if err != nil {
		t.Fatal(err)
	}

	// An attacker holding every server-side column must not recover
	// the room key without the password.
	if bytes.Contains(blob, key) {
		t.Error("keyblob contains the room key in the clear")
	}

	if bytes.Contains(authHash, key) {
		t.Error("auth hash contains the room key")
	}

	if len(authSalt) != saltSize || len(keySalt) != saltSize {
		t.Errorf("salt lengths = %d/%d, want %d", len(authSalt), len(keySalt), saltSize)
	}
}

func TestSlug(t *testing.T) {
	t.Parallel()

	seen := map[string]bool{}

	for range 1000 {
		slug := roomcrypt.NewSlug()
		if len(slug) != slugLen || slug[3] != '-' || slug[7] != '-' {
			t.Fatalf("malformed slug %q", slug)
		}

		seen[slug] = true
	}

	if len(seen) < 990 {
		t.Errorf("slug entropy too low: %d unique of 1000", len(seen))
	}
}

func TestB64RoundTrip(t *testing.T) {
	t.Parallel()

	key := roomcrypt.NewKey()
	encoded := roomcrypt.B64(key)

	decoded, err := roomcrypt.UnB64(encoded)
	if err != nil {
		t.Fatal(err)
	}

	if !bytes.Equal(decoded, key) {
		t.Error("base64url round trip failed")
	}
}
