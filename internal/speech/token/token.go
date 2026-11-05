// Package token mints and verifies the short-lived tokens that admit a
// meeting member to the speech service.
package token

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

var (
	errMalformed = errors.New("token: malformed")
	errSignature = errors.New("token: bad signature")
	errExpired   = errors.New("token: expired")
)

// Claims name the room and member a token admits, and its expiry in Unix seconds.
type Claims struct {
	Room   string `json:"room"`
	Member string `json:"member"`
	Exp    int64  `json:"exp"`
}

// Mint signs claims as "<payload>.<signature>": unpadded base64url of the
// JSON claims and of an HMAC-SHA256 over the encoded payload.
func Mint(secret []byte, claims Claims) (string, error) {
	encoded, err := json.Marshal(claims)
	if err != nil {
		return "", fmt.Errorf("token: encode claims: %w", err)
	}

	payload := base64.RawURLEncoding.EncodeToString(encoded)

	return payload + "." + sign(secret, payload), nil
}

// Verify returns the claims of a token signed with secret that has not
// expired at now.
func Verify(secret []byte, token string, now time.Time) (Claims, error) {
	payload, signature, found := strings.Cut(token, ".")
	if !found || payload == "" || signature == "" {
		return Claims{}, errMalformed
	}

	if !hmac.Equal([]byte(sign(secret, payload)), []byte(signature)) {
		return Claims{}, errSignature
	}

	decoded, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return Claims{}, fmt.Errorf("token: decode payload: %w", err)
	}

	var claims Claims

	err = json.Unmarshal(decoded, &claims)
	if err != nil {
		return Claims{}, fmt.Errorf("token: parse claims: %w", err)
	}

	if now.After(time.Unix(claims.Exp, 0)) {
		return Claims{}, errExpired
	}

	return claims, nil
}

func sign(secret []byte, payload string) string {
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte(payload))

	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}
