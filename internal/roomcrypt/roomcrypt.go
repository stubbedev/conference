// Package roomcrypt implements the room key distribution scheme.
//
// Every room has a 256-bit room key K. Media frames and chat messages are
// encrypted client-side with subkeys derived from K, so the SFU relays
// ciphertext it cannot decrypt.
//
// Password-protected rooms never hand K to the server after creation:
//   - authentication uses PBKDF2-SHA256(password, authSalt) compared by hash
//   - K is returned as an AES-256-GCM keyblob sealed under
//     PBKDF2-SHA256(password, keySalt), decrypted only in the browser
//
// Privileged links carry K in the URL fragment, which browsers never send
// to the server. Keyless ("open") rooms store K server-side; joining such
// a room protects media against network eavesdroppers, not against the
// server operator. This tradeoff is documented in the README.
package roomcrypt

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
)

const (
	// KeyLen is the size of a room key or derived key in bytes.
	KeyLen = 32
	// ProofIterations is the PBKDF2 iteration count for proofs and
	// key-encryption keys. Keep in sync with the web client.
	ProofIterations = 210000
	saltLen         = 16
)

// ErrBadProof is returned when a password proof or keyblob fails to verify.
var ErrBadProof = errors.New("roomcrypt: bad proof")

// B64 encodes bytes as unpadded base64url.
func B64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// UnB64 decodes unpadded base64url.
func UnB64(s string) ([]byte, error) {
	decoded, err := base64.RawURLEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("roomcrypt: base64: %w", err)
	}

	return decoded, nil
}

// NewKey returns a random room key.
func NewKey() []byte {
	key := make([]byte, KeyLen)

	_, err := rand.Read(key)
	if err != nil {
		panic(err) // crypto/rand failure is unrecoverable
	}

	return key
}

// NewToken returns a random opaque token (privileged links, sessions).
func NewToken() string { return B64(NewKey()) }

// HashToken hashes a token for at-rest storage.
func HashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))

	return sum[:]
}

const slugAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"

// slugEncodedLen is the length of an encoded slug: nine characters
// grouped in threes and joined by dashes.
const slugEncodedLen = 11

// NewSlug returns a Meet-style xxx-yyy-zzz room slug.
func NewSlug() string {
	var buf [9]byte

	_, err := rand.Read(buf[:])
	if err != nil {
		panic(err)
	}

	out := make([]byte, 0, slugEncodedLen)

	for i, c := range buf {
		if i > 0 && i%3 == 0 {
			out = append(out, '-')
		}

		out = append(out, slugAlphabet[int(c)%len(slugAlphabet)])
	}

	return string(out)
}

func newSalt() []byte {
	salt := make([]byte, saltLen)

	_, err := rand.Read(salt)
	if err != nil {
		panic(err)
	}

	return salt
}

// DeriveProof derives the password authentication proof.
func DeriveProof(password string, salt []byte) ([]byte, error) {
	proof, err := pbkdf2.Key(sha256.New, password, salt, ProofIterations, KeyLen)
	if err != nil {
		return nil, fmt.Errorf("roomcrypt: pbkdf2: %w", err)
	}

	return proof, nil
}

// VerifyProof reports whether the password proof matches.
func VerifyProof(proof, expected []byte) bool {
	return len(proof) == len(expected) && subtleEqual(proof, expected)
}

func subtleEqual(a, b []byte) bool {
	var diff byte

	for i := range a {
		diff |= a[i] ^ b[i]
	}

	return diff == 0
}

func derivationKey(password string, salt []byte) ([]byte, error) {
	return DeriveProof(password, salt)
}

// SealKeyblob encrypts the room key under a password-derived key. The
// result is nonce || ciphertext || tag.
func SealKeyblob(key []byte, password string, keySalt []byte) ([]byte, error) {
	kek, err := derivationKey(password, keySalt)
	if err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(kek)
	if err != nil {
		return nil, fmt.Errorf("roomcrypt: aes: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("roomcrypt: gcm: %w", err)
	}

	nonce := make([]byte, gcm.NonceSize())

	_, err = rand.Read(nonce)
	if err != nil {
		return nil, fmt.Errorf("roomcrypt: nonce: %w", err)
	}

	return gcm.Seal(nonce, nonce, key, nil), nil
}

// OpenKeyblob decrypts a keyblob produced by SealKeyblob.
func OpenKeyblob(blob []byte, password string, keySalt []byte) ([]byte, error) {
	if len(blob) < 12+16 {
		return nil, ErrBadProof
	}

	kek, err := derivationKey(password, keySalt)
	if err != nil {
		return nil, err
	}

	block, err := aes.NewCipher(kek)
	if err != nil {
		return nil, fmt.Errorf("roomcrypt: aes: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("roomcrypt: gcm: %w", err)
	}

	nonce, ct := blob[:gcm.NonceSize()], blob[gcm.NonceSize():]

	key, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		return nil, ErrBadProof
	}

	return key, nil
}

// NewPasswordMaterials derives the salts and hashes for a password-
// protected room and seals the room key into a keyblob.
func NewPasswordMaterials(key []byte, password string) ([]byte, []byte, []byte, []byte, error) {
	authSalt, keySalt := newSalt(), newSalt()

	authHash, err := DeriveProof(password, authSalt)
	if err != nil {
		return nil, nil, nil, nil, err
	}

	keyblob, err := SealKeyblob(key, password, keySalt)
	if err != nil {
		return nil, nil, nil, nil, err
	}

	return authSalt, authHash, keySalt, keyblob, nil
}
