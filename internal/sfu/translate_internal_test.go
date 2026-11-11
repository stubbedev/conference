package sfu

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"strings"
	"testing"
)

const translationDE = Kind(KindTranslationPrefix + "de")

type captionLimits struct {
	TextMax       int `json:"captionTextMax"`
	LabelMax      int `json:"captionLabelMax"`
	CiphertextMax int `json:"captionCiphertextMax"`
}

func sealCaption(t *testing.T, plaintext string) Message {
	t.Helper()

	key := make([]byte, 32)

	_, err := rand.Read(key)
	if err != nil {
		t.Fatalf("room key: %v", err)
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("gcm: %v", err)
	}

	nonce := make([]byte, gcm.NonceSize())

	_, err = rand.Read(nonce)
	if err != nil {
		t.Fatalf("nonce: %v", err)
	}

	return Message{
		Type: "caption",
		IV:   base64.RawURLEncoding.EncodeToString(nonce),
		CT:   base64.RawURLEncoding.EncodeToString(gcm.Seal(nil, nonce, []byte(plaintext), nil)),
	}
}

func TestTheLargestCaptionFitsExactly(t *testing.T) {
	t.Parallel()

	label := strings.Repeat(`\u0001`, captionLabelMax)
	text := strings.Repeat(`\u0001`, captionTextMax)
	largest := sealCaption(t, `{"k":"translation","by":"`+label+`","speaker":"`+label+`","segId":"`+label+
		`","sourceLang":"`+label+`","lang":"`+label+`","text":"`+text+`","final":false}`)

	if len(largest.CT) != maxCaptionCiphertext {
		t.Fatalf("the largest caption seals to %d characters, the cap is %d", len(largest.CT), maxCaptionCiphertext)
	}

	if !sealed(largest, maxCaptionCiphertext) {
		t.Fatal("the largest caption is refused")
	}

	largest.CT += "x"
	if sealed(largest, maxCaptionCiphertext) {
		t.Fatal("a caption larger than the largest is relayed")
	}
}

func TestCaptionLimitsFixture(t *testing.T) {
	t.Parallel()

	matchesFixture(t, "caption-limits.json", captionLimits{
		TextMax: captionTextMax, LabelMax: captionLabelMax, CiphertextMax: maxCaptionCiphertext,
	})
}

func TestTranslationTracksAreAudio(t *testing.T) {
	t.Parallel()

	for kind, audio := range map[Kind]bool{
		KindAudio:       true,
		KindScreenAudio: true,
		translationDE:   true,
		KindCamera:      false,
		KindScreen:      false,
	} {
		if kind.audio() != audio {
			t.Errorf("kind %q: audio() = %v, want %v", kind, !audio, audio)
		}
	}
}

func TestOnlyTheClientsKindsAreKnown(t *testing.T) {
	t.Parallel()

	for kind, known := range map[Kind]bool{
		KindAudio:                   true,
		KindCamera:                  true,
		KindScreen:                  true,
		KindScreenAudio:             true,
		translationDE:               true,
		Kind(KindTranslationPrefix): false,
		"unknown":                   false,
		"":                          false,
	} {
		if kind.known() != known {
			t.Errorf("kind %q: known() = %v, want %v", kind, !known, known)
		}
	}
}
