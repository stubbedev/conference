package sfu

import (
	"errors"
	"strings"
	"time"

	"github.com/stubbe/conference/internal/speech/token"
)

// Live translation: while a host has it switched on, every member's
// browser streams its own speech to our own speech service and feeds its
// own subtitles and translated voice back into the room. As with
// recording, the SFU never sees plaintext — language choices and
// captions are sealed with the room key, and translated voices are
// ordinary E2EE audio tracks — so the server only relays ciphertext,
// keeps the room mode and hands out speech tokens.

// KindTranslationPrefix labels a translated-voice audio track; the
// target language code follows it, e.g. "translation-de".
const KindTranslationPrefix = "translation-"

const (
	maxLangCiphertext    = 1 << 10
	maxCaptionCiphertext = 4 << 10
	speechTokenTTL       = time.Hour
)

// ErrTranslationUnavailable rejects translation when no speech service
// is configured or its engines are not set up.
var ErrTranslationUnavailable = errors.New("sfu: live translation is not available")

// SpeechConfig points the hub at the speech service. Secret is shared
// with that service, which verifies the tokens minted here. Ready, when
// set, reports whether the service's engines are set up.
type SpeechConfig struct {
	URL    string
	Secret []byte
	Ready  func() bool
}

func (c *SpeechConfig) available() bool {
	return c != nil && (c.Ready == nil || c.Ready())
}

// isAudioKind reports whether a track kind carries audio.
func isAudioKind(kind string) bool {
	return kind == KindAudio || strings.HasPrefix(kind, KindTranslationPrefix)
}

func sealed(msg Message, maxCiphertext int) bool {
	return msg.IV != "" && msg.CT != "" && len(msg.CT) <= maxCiphertext
}

// handleLang relays a member's sealed language preferences.
func (m *Member) handleLang(msg Message) {
	if !sealed(msg, maxLangCiphertext) {
		m.fail("bad-lang", ErrBadRequest)

		return
	}

	m.room.broadcastExcept(m.ID, Message{Type: "lang", From: m.ID, IV: msg.IV, CT: msg.CT})
}

// handleCaption relays a sealed subtitle while live translation is on.
// Any member may send them: each browser translates its own speech, and
// receivers check that a caption's sealed speaker matches From.
func (m *Member) handleCaption(msg Message) {
	if !m.room.isTranslating() {
		m.fail("not-allowed", ErrForbidden)

		return
	}

	if !sealed(msg, maxCaptionCiphertext) {
		m.fail("bad-caption", ErrBadRequest)

		return
	}

	m.room.broadcastExcept(m.ID, Message{Type: "caption", From: m.ID, IV: msg.IV, CT: msg.CT})
}

// handleTranslate switches the room's live translation on or off. It is
// a room mode, host-gated, replayed to late joiners and kept when the
// host who started it leaves. While it is on every member, joiners
// included, gets its own token for the speech service.
func (m *Member) handleTranslate(msg Message) {
	if !m.priv {
		m.fail("not-allowed", ErrForbidden)

		return
	}

	if msg.On && !m.room.cfg.Speech.available() {
		m.fail("translate-unavailable", ErrTranslationUnavailable)

		return
	}

	if !m.room.setTranslating(m.ID, msg.On) {
		return
	}

	m.room.broadcast(Message{Type: "translating", From: m.ID, On: msg.On})

	if msg.On {
		for _, member := range m.room.snapshot() {
			member.sendSpeechToken()
		}
	}
}

// handleTokenRequest hands out a fresh speech token, e.g. before the
// last one expires, while live translation is on.
func (m *Member) handleTokenRequest() {
	if m.room.isTranslating() {
		m.sendSpeechToken()
	}
}

func (m *Member) sendSpeechToken() {
	speech := m.room.cfg.Speech
	if speech == nil {
		return
	}

	minted, err := token.Mint(speech.Secret, token.Claims{
		Room:   m.room.slug,
		Member: m.ID,
		Exp:    time.Now().Add(speechTokenTTL).Unix(),
	})
	if err != nil {
		m.fail("translate-token", err)

		return
	}

	m.send(Message{Type: "translate-token", URL: speech.URL, Token: minted})
}

// setTranslating turns the mode on (remembering who started it) or off,
// and reports whether that changed anything.
func (r *Room) setTranslating(starter string, enable bool) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	if enable == (r.translatingBy != "") {
		return false
	}

	if enable {
		r.translatingBy = starter
	} else {
		r.translatingBy = ""
	}

	return true
}

func (r *Room) isTranslating() bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	return r.translatingBy != ""
}
