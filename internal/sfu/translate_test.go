package sfu_test

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stubbe/conference/internal/relay"
	"github.com/stubbe/conference/internal/sfu"
)

const (
	msgTranslating = "translating"
	msgToken       = "translate-token"
	msgTokenAsk    = "translate-token-request"
	translate      = "translate"
	speechURL      = "wss://speech.example/v1/stream"
	speechSecret   = "test-secret"
	msgCaption     = "caption"
	msgLang        = "lang"
	codeNotAllowed = "not-allowed"
	sealedPrefs    = "sealed-prefs"
)

func newTranslateHub(t *testing.T) (*sfu.Hub, *sfu.Engine) {
	t.Helper()

	return newSpeechHub(t, nil)
}

func newSpeechHub(t *testing.T, ready func() bool) (*sfu.Hub, *sfu.Engine) {
	t.Helper()

	engine, closeEngine, err := sfu.NewEngine(0, nil)
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	t.Cleanup(closeEngine)

	creds, err := relay.NewCredentials(relay.Config{Port: testTURNPort, TLSHost: ""})
	if err != nil {
		t.Fatal(err)
	}

	return sfu.NewHub(sfu.HubConfig{
		Engine: engine, Relay: creds, MaxMembers: 8, MaxPublishKbps: 2500,
		Speech: &sfu.SpeechConfig{URL: speechURL, Secret: []byte(speechSecret), Ready: ready},
	}), engine
}

func expectTranslating(t *testing.T, peer *testPeer, fromID string, announced bool) {
	t.Helper()

	msg := peer.next(t, msgTranslating)

	if msg.From != fromID || msg.On != announced {
		t.Fatalf("%s expected translating on=%v from %q, got on=%v from %q", peer.member.Name, announced, fromID, msg.On, msg.From)
	}
}

// expectToken asserts the next translate-token names the speech service
// and carries a valid, unexpired token for this member.
func expectToken(t *testing.T, peer *testPeer) {
	t.Helper()

	msg := peer.next(t, msgToken)
	if msg.URL != speechURL {
		t.Fatalf("token URL %q, want %q", msg.URL, speechURL)
	}

	payload, signature, ok := strings.Cut(msg.Token, ".")
	if !ok {
		t.Fatalf("malformed token %q", msg.Token)
	}

	mac := hmac.New(sha256.New, []byte(speechSecret))
	mac.Write([]byte(payload))

	if base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) != signature {
		t.Fatal("token signature does not verify")
	}

	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		t.Fatal(err)
	}

	var claims struct {
		Room   string `json:"room"`
		Member string `json:"member"`
		Exp    int64  `json:"exp"`
	}

	err = json.Unmarshal(raw, &claims)
	if err != nil {
		t.Fatal(err)
	}

	if claims.Room != testSlug || claims.Member != peer.member.ID || claims.Exp <= time.Now().Unix() {
		t.Fatalf("unexpected claims %+v", claims)
	}
}

// expectNo asserts that no message of msgType is queued for peer.
func expectNo(t *testing.T, peer *testPeer, msgType string) {
	t.Helper()

	time.Sleep(100 * time.Millisecond)

	for _, msg := range peer.drain() {
		if msg.Type == msgType {
			t.Fatalf("%s got an unexpected %s: %+v", peer.member.Name, msgType, msg)
		}
	}
}

func TestTranslationUnavailableWithoutSpeechService(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewEngine(0, nil)
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	host := newTestPeer(t, newTestHub(t, engine), engine, "host", true)
	host.member.Handle(sfu.Message{Type: translate, On: true})

	if msg := host.next(t, "error"); msg.Code != "translate-unavailable" {
		t.Fatalf("expected translate-unavailable, got %q", msg.Code)
	}
}

func TestTranslationUnavailableUntilSpeechServiceReady(t *testing.T) {
	t.Parallel()

	hub, engine := newSpeechHub(t, func() bool { return false })

	host := newTestPeer(t, hub, engine, "host", true)
	host.member.Handle(sfu.Message{Type: translate, On: true})

	if msg := host.next(t, "error"); msg.Code != "translate-unavailable" {
		t.Fatalf("expected translate-unavailable, got %q", msg.Code)
	}
}

// TestTranslationMode checks the room mode: host-gated, announced to
// everyone, a token for every member, replayed to joiners with a token
// of their own, and a second switch-on changing nothing.
func TestTranslationMode(t *testing.T) {
	t.Parallel()

	hub, engine := newTranslateHub(t)

	host := newTestPeer(t, hub, engine, "host", true)
	guest := newTestPeer(t, hub, engine, "guest", false)

	guest.member.Handle(sfu.Message{Type: translate, On: true})

	if msg := guest.next(t, "error"); msg.Code != codeNotAllowed {
		t.Fatalf("guest expected not-allowed, got %q", msg.Code)
	}

	host.member.Handle(sfu.Message{Type: translate, On: true})
	expectTranslating(t, host, host.member.ID, true)
	expectTranslating(t, guest, host.member.ID, true)
	expectToken(t, host)
	expectToken(t, guest)

	host2 := newTestPeer(t, hub, engine, "host2", true)
	if msg := host2.next(t, "welcome"); msg.TranslatingBy != host.member.ID {
		t.Fatalf("joiner expected translation started by %q, got %q", host.member.ID, msg.TranslatingBy)
	}

	expectToken(t, host2)

	host2.member.Handle(sfu.Message{Type: translate, On: true})
	expectNo(t, guest, msgTranslating)
}

// TestTranslationOutlivesItsStarter checks that translation keeps going
// when the host who switched it on leaves, until a host switches it off.
func TestTranslationOutlivesItsStarter(t *testing.T) {
	t.Parallel()

	hub, engine := newTranslateHub(t)

	host := newTestPeer(t, hub, engine, "host", true)
	guest := newTestPeer(t, hub, engine, "guest", false)
	host2 := newTestPeer(t, hub, engine, "host2", true)

	host.member.Handle(sfu.Message{Type: translate, On: true})
	expectTranslating(t, guest, host.member.ID, true)

	host.member.Leave()
	guest.next(t, "member-left")
	expectNo(t, guest, msgTranslating)

	late := newTestPeer(t, hub, engine, "late", false)
	if msg := late.next(t, "welcome"); msg.TranslatingBy == "" {
		t.Fatal("translation stopped when its starter left")
	}

	expectToken(t, late)

	host2.member.Handle(sfu.Message{Type: translate, On: false})
	expectTranslating(t, guest, host2.member.ID, false)

	late.member.Handle(sfu.Message{Type: msgTokenAsk})
	expectNo(t, late, msgToken)
}

func TestTokenRequest(t *testing.T) {
	t.Parallel()

	hub, engine := newTranslateHub(t)

	host := newTestPeer(t, hub, engine, "host", true)
	guest := newTestPeer(t, hub, engine, "guest", false)

	guest.member.Handle(sfu.Message{Type: msgTokenAsk})
	expectNo(t, guest, msgToken)

	host.member.Handle(sfu.Message{Type: translate, On: true})
	expectToken(t, guest)

	guest.member.Handle(sfu.Message{Type: msgTokenAsk})
	expectToken(t, guest)
}

// TestCaptionsFromAnyMember checks that every member may caption its own
// speech while translation is on, and nobody while it is off.
func TestCaptionsFromAnyMember(t *testing.T) {
	t.Parallel()

	hub, engine := newTranslateHub(t)

	host := newTestPeer(t, hub, engine, "host", true)
	guest := newTestPeer(t, hub, engine, "guest", false)
	caption := sfu.Message{Type: msgCaption, IV: "iv", CT: "ciphertext"}

	guest.member.Handle(caption)

	if msg := guest.next(t, "error"); msg.Code != codeNotAllowed {
		t.Fatalf("captions while off: expected not-allowed, got %q", msg.Code)
	}

	host.member.Handle(sfu.Message{Type: translate, On: true})
	expectTranslating(t, guest, host.member.ID, true)

	guest.member.Handle(caption)

	if msg := host.next(t, msgCaption); msg.From != guest.member.ID || msg.IV != caption.IV || msg.CT != caption.CT {
		t.Fatalf("host got caption %+v, want the guest's sealed caption", msg)
	}

	host.member.Handle(caption)

	if msg := guest.next(t, msgCaption); msg.From != host.member.ID {
		t.Fatalf("guest got caption from %q, want the host", msg.From)
	}

	for _, bad := range []sfu.Message{
		{Type: msgCaption, IV: "iv", CT: ""},
		{Type: msgCaption, IV: "iv", CT: strings.Repeat("x", 4<<10+1)},
	} {
		guest.member.Handle(bad)

		if msg := guest.next(t, "error"); msg.Code != "bad-caption" {
			t.Fatalf("expected bad-caption, got %q", msg.Code)
		}
	}
}

func TestLangRelay(t *testing.T) {
	t.Parallel()

	hub, engine := newTranslateHub(t)

	host := newTestPeer(t, hub, engine, "host", true)
	guest := newTestPeer(t, hub, engine, "guest", false)

	guest.member.Handle(sfu.Message{Type: msgLang, IV: "iv", CT: sealedPrefs})

	if msg := host.next(t, msgLang); msg.From != guest.member.ID || msg.CT != sealedPrefs {
		t.Fatalf("host got lang %+v, want the guest's sealed prefs", msg)
	}

	expectNo(t, guest, msgLang)

	guest.member.Handle(sfu.Message{Type: msgLang, IV: "", CT: sealedPrefs})

	if msg := guest.next(t, "error"); msg.Code != "bad-lang" {
		t.Fatalf("expected bad-lang, got %q", msg.Code)
	}
}

// TestResumeKeepsTranslation checks that a rejoining starter keeps the
// mode attributed to it and gets a token for its new session.
func TestResumeKeepsTranslation(t *testing.T) {
	t.Parallel()

	hub, engine := newTranslateHub(t)

	host := newTestPeer(t, hub, engine, "host", true)
	guest := newTestPeer(t, hub, engine, "guest", false)

	token := host.next(t, "welcome").Resume

	host.member.Handle(sfu.Message{Type: translate, On: true})
	expectTranslating(t, guest, host.member.ID, true)

	rejoined := joinTestPeer(t, hub, engine, sfu.JoinRequest{
		Slug: testSlug, RoomName: testRoomName, MemberName: "host",
		MaxMembers: 8, Priv: true, Host: testHost, Resume: token,
	})

	if welcome := rejoined.next(t, "welcome"); welcome.TranslatingBy != rejoined.member.ID {
		t.Fatalf("rejoined welcome names %q, want %s", welcome.TranslatingBy, rejoined.member.ID)
	}

	expectToken(t, rejoined)

	guest.next(t, "member-left")
	expectNo(t, guest, msgTranslating)
}
