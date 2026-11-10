package sfu_test

import (
	"strings"
	"sync"
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
	msgCaption     = "caption"
	msgLang        = "lang"
	codeNotAllowed = "not-allowed"
	sealedPrefs    = "sealed-prefs"
)

// roomTokens hands out "<room>/<member>" as the speech token.
type roomTokens struct{}

func (roomTokens) Token(room, member string) (string, error) {
	return room + "/" + member, nil
}

func newTranslateHub(t *testing.T) (*sfu.Hub, *sfu.Engine) {
	t.Helper()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	t.Cleanup(closeEngine)

	creds, err := relay.NewCredentials(relay.Config{Port: testTURNPort, TLSHost: ""})
	if err != nil {
		t.Fatal(err)
	}

	return sfu.NewHub(sfu.HubConfig{
		Engine: engine, Relay: creds, MaxMembers: 8,
		Speech: roomTokens{}, Translate: true,
	}), engine
}

func expectTranslating(t *testing.T, peer *testPeer, fromID string, announced bool) {
	t.Helper()

	msg := peer.next(t, msgTranslating)

	if msg.From != fromID || msg.On != announced {
		t.Fatalf("%s expected translating on=%v from %q, got on=%v from %q", peer.member.Name, announced, fromID, msg.On, msg.From)
	}
}

// expectToken asserts the next translate-token carries this member's
// token for the room.
func expectToken(t *testing.T, peer *testPeer) {
	t.Helper()

	msg := peer.next(t, msgToken)
	if want := testSlug + "/" + peer.member.ID; msg.Token != want {
		t.Fatalf("token %q, want %q", msg.Token, want)
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

func TestTranslationUnavailableWithoutSpeechEngines(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
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

// TestTranslationWithoutSpeechStreams checks the room mode where the
// browsers run the engines: the switch works with no speech service to
// stream to, and no member is handed a token for one.
func TestTranslationWithoutSpeechStreams(t *testing.T) {
	t.Parallel()

	engine, closeEngine, err := sfu.NewLoopbackEngine()
	if err != nil {
		t.Fatalf("engine: %v", err)
	}

	defer closeEngine()

	creds, err := relay.NewCredentials(relay.Config{Port: testTURNPort, TLSHost: ""})
	if err != nil {
		t.Fatal(err)
	}

	hub := sfu.NewHub(sfu.HubConfig{
		Engine: engine, Relay: creds, MaxMembers: 8,
		Speech: nil, Translate: true,
	})

	host := newTestPeer(t, hub, engine, "host", true)
	guest := newTestPeer(t, hub, engine, "guest", false)

	host.member.Handle(sfu.Message{Type: translate, On: true})
	expectTranslating(t, guest, host.member.ID, true)

	joiner := newTestPeer(t, hub, engine, "joiner", false)
	expectNo(t, host, msgToken)
	expectNo(t, guest, msgToken)
	expectNo(t, joiner, msgToken)
}

// TestTranslationMode checks the room mode: open to every member,
// announced to everyone, a token for every member, replayed to joiners
// with a token of their own, and a second switch-on changing nothing.
func TestTranslationMode(t *testing.T) {
	t.Parallel()

	hub, engine := newTranslateHub(t)

	host := newTestPeer(t, hub, engine, "host", true)
	guest := newTestPeer(t, hub, engine, "guest", false)

	guest.member.Handle(sfu.Message{Type: translate, On: true})
	expectTranslating(t, guest, guest.member.ID, true)
	expectTranslating(t, host, guest.member.ID, true)
	expectToken(t, guest)
	expectToken(t, host)

	joiner := newTestPeer(t, hub, engine, "joiner", false)
	if msg := joiner.next(t, "welcome"); msg.TranslatingBy != guest.member.ID {
		t.Fatalf("joiner expected translation started by %q, got %q", guest.member.ID, msg.TranslatingBy)
	}

	expectToken(t, joiner)

	host.member.Handle(sfu.Message{Type: translate, On: true})
	expectNo(t, guest, msgTranslating)
}

// TestTranslationOutlivesItsStarter checks that translation keeps going
// when the member who switched it on leaves, until any member switches
// it off.
func TestTranslationOutlivesItsStarter(t *testing.T) {
	t.Parallel()

	hub, engine := newTranslateHub(t)

	host := newTestPeer(t, hub, engine, "host", true)
	guest := newTestPeer(t, hub, engine, "guest", false)

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

	late.member.Handle(sfu.Message{Type: translate, On: false})
	expectTranslating(t, guest, late.member.ID, false)

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

func keepToggling(switcher *sfu.Member) func() {
	stop := make(chan struct{})
	stopped := make(chan struct{})

	go func() {
		defer close(stopped)

		for on := true; ; on = !on {
			select {
			case <-stop:
				return
			default:
				switcher.Handle(sfu.Message{Type: translate, On: on})
			}
		}
	}()

	return func() {
		close(stop)
		<-stopped
	}
}

func firstMessageOfJoin(t *testing.T, hub *sfu.Hub, req sfu.JoinRequest, left <-chan string) string {
	t.Helper()

	var (
		mu    sync.Mutex
		first string
	)

	joiner, err := hub.JoinRoom(req, func(msg sfu.Message) {
		mu.Lock()
		defer mu.Unlock()

		if first == "" {
			first = msg.Type
		}
	})
	if err != nil {
		t.Fatalf("join: %v", err)
	}

	joiner.Leave()

	select {
	case id := <-left:
		if id != joiner.ID {
			t.Fatalf("member %s left, want %s", id, joiner.ID)
		}
	case <-time.After(testTimeout):
		t.Fatal("the joiner never left")
	}

	mu.Lock()
	defer mu.Unlock()

	return first
}

func TestWelcomeComesFirstWhileTranslationToggles(t *testing.T) {
	t.Parallel()

	const joins = 300

	hub, _ := newTranslateHub(t)
	request := func(name string) sfu.JoinRequest {
		return sfu.JoinRequest{
			Slug: testSlug, RoomName: testRoomName, MemberName: name,
			MaxMembers: 8, Priv: false, Host: testHost, Resume: "",
		}
	}

	left := make(chan string, joins)

	switcher, err := hub.JoinRoom(request("switcher"), func(msg sfu.Message) {
		if msg.Type == "member-left" {
			left <- msg.ID
		}
	})
	if err != nil {
		t.Fatalf("switcher join: %v", err)
	}

	defer switcher.Leave()
	defer keepToggling(switcher)()

	for join := range joins {
		if first := firstMessageOfJoin(t, hub, request("joiner"), left); first != "welcome" {
			t.Fatalf("join %d: first message %q, want the welcome", join, first)
		}
	}
}
