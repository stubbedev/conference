package api_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"
)

const (
	slackSecret      = "8f742231b10e8888abcd99yyyzzz85a5"
	slackOrigin      = "https://meet.example.com"
	slackResponseURL = "https://hooks.slack.com/commands/T1/42/abc"
	slackPath        = "/api/slack/meet"
	followUpWait     = 5 * time.Second
)

var roomLink = regexp.MustCompile(regexp.QuoteMeta(slackOrigin) + `/r/([^\s|>?#]+)`)

type slackReply struct {
	ResponseType    string `json:"response_type"`    //nolint:tagliatelle // Slack's wire format.
	ReplaceOriginal bool   `json:"replace_original"` //nolint:tagliatelle // Slack's wire format.
	Text            string `json:"text"`
}

type followUp struct {
	url  string
	body slackReply
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func newSlackServer(t *testing.T) (http.Handler, <-chan followUp) {
	t.Helper()

	cfg := testConfig()
	cfg.BaseURL = slackOrigin
	cfg.SlackSigningSecret = slackSecret

	server := newTestAPI(t, cfg)
	followUps := make(chan followUp, 1)

	server.SlackClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		var body slackReply

		err := json.NewDecoder(r.Body).Decode(&body)
		if err != nil {
			t.Errorf("decode follow-up: %v", err)
		}

		followUps <- followUp{url: r.URL.String(), body: body}

		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader("ok")), Request: r}, nil
	})}

	return routes(server), followUps
}

func slackForm(text string) url.Values {
	return url.Values{
		"command":      {"/meet"},
		"text":         {text},
		"user_id":      {"U2147483697"},
		"team_id":      {"T1"},
		"response_url": {slackResponseURL},
	}
}

func signedSlackRequest(t *testing.T, secret string, form url.Values, sent time.Time) *http.Request {
	t.Helper()

	body := form.Encode()
	timestamp := strconv.FormatInt(sent.Unix(), 10)

	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte("v0:" + timestamp + ":" + body))

	req := httptest.NewRequestWithContext(context.Background(), http.MethodPost, slackPath, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("X-Slack-Request-Timestamp", timestamp)
	req.Header.Set("X-Slack-Signature", "v0="+hex.EncodeToString(mac.Sum(nil)))

	return req
}

func serve(handler http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	return rec
}

func decodeReply(t *testing.T, rec *httptest.ResponseRecorder) slackReply {
	t.Helper()

	var reply slackReply

	err := json.Unmarshal(rec.Body.Bytes(), &reply)
	if err != nil {
		t.Fatalf("decode reply %q: %v", rec.Body.String(), err)
	}

	return reply
}

func TestSlackMeetCreatesOpenRoom(t *testing.T) {
	t.Parallel()

	handler, followUps := newSlackServer(t)

	rec := serve(handler, signedSlackRequest(t, slackSecret, slackForm("  Standup  "), time.Now()))
	if rec.Code != http.StatusOK {
		t.Fatalf("got status %d: %s", rec.Code, rec.Body.String())
	}

	slug := assertAnnouncement(t, decodeReply(t, rec), "<@U2147483697> started *Standup*")

	info := do(t, handler, http.MethodGet, "/api/rooms/"+slug, "")
	if info.Code != http.StatusOK || !strings.Contains(info.Body.String(), `"requiresPassword":false`) {
		t.Fatalf("room %s: status %d body %s", slug, info.Code, info.Body.String())
	}

	assertHostFollowUp(t, followUps, slug)
}

// assertAnnouncement checks the public channel message and returns the
// slug of the room it links to.
func assertAnnouncement(t *testing.T, reply slackReply, lead string) string {
	t.Helper()

	if reply.ResponseType != "in_channel" || !strings.HasPrefix(reply.Text, lead) {
		t.Fatalf("got %+v, want an in_channel message starting %q", reply, lead)
	}

	if strings.Contains(reply.Text, "?p=") || strings.Contains(reply.Text, "#k=") {
		t.Fatalf("channel message leaks the moderator link: %q", reply.Text)
	}

	match := roomLink.FindStringSubmatch(reply.Text)
	if match == nil {
		t.Fatalf("announcement %q has no room link", reply.Text)
	}

	return match[1]
}

func assertHostFollowUp(t *testing.T, followUps <-chan followUp, slug string) {
	t.Helper()

	select {
	case got := <-followUps:
		if got.url != slackResponseURL || got.body.ResponseType != "ephemeral" || got.body.ReplaceOriginal {
			t.Fatalf("follow-up went to %q as %+v", got.url, got.body)
		}

		hostLink := slackOrigin + "/r/" + slug + "?p="
		if !strings.Contains(got.body.Text, hostLink) || !strings.Contains(got.body.Text, "#k=") {
			t.Fatalf("follow-up %q lacks the moderator link", got.body.Text)
		}
	case <-time.After(followUpWait):
		t.Fatal("no follow-up with the moderator link")
	}
}

func TestSlackMeetWithoutName(t *testing.T) {
	t.Parallel()

	handler, _ := newSlackServer(t)

	reply := decodeReply(t, serve(handler, signedSlackRequest(t, slackSecret, slackForm(""), time.Now())))
	assertAnnouncement(t, reply, "<@U2147483697> started a meeting: <"+slackOrigin+"/r/")
}

func TestSlackMeetEscapesName(t *testing.T) {
	t.Parallel()

	handler, _ := newSlackServer(t)

	reply := decodeReply(t, serve(handler, signedSlackRequest(t, slackSecret, slackForm("<!channel> & co"), time.Now())))
	if !strings.Contains(reply.Text, "*&lt;!channel&gt; &amp; co*") {
		t.Fatalf("name not escaped: %q", reply.Text)
	}
}

func TestSlackMeetRejectsLongName(t *testing.T) {
	t.Parallel()

	handler, _ := newSlackServer(t)

	reply := decodeReply(t, serve(handler, signedSlackRequest(t, slackSecret, slackForm(strings.Repeat("x", 81)), time.Now())))
	if reply.ResponseType != "ephemeral" || roomLink.MatchString(reply.Text) {
		t.Fatalf("got %+v", reply)
	}
}

func TestSlackMeetRejectsUnverifiedRequests(t *testing.T) {
	t.Parallel()

	handler, followUps := newSlackServer(t)

	for name, req := range map[string]*http.Request{
		"wrong secret":     signedSlackRequest(t, "not-the-secret", slackForm("x"), time.Now()),
		"stale timestamp":  signedSlackRequest(t, slackSecret, slackForm("x"), time.Now().Add(-6*time.Minute)),
		"future timestamp": signedSlackRequest(t, slackSecret, slackForm("x"), time.Now().Add(6*time.Minute)),
	} {
		rec := serve(handler, req)
		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s: got status %d, want %d", name, rec.Code, http.StatusUnauthorized)
		}
	}

	tampered := signedSlackRequest(t, slackSecret, slackForm("x"), time.Now())
	tampered.Body = io.NopCloser(strings.NewReader(slackForm("y").Encode()))

	rec := serve(handler, tampered)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("tampered body: got status %d, want %d", rec.Code, http.StatusUnauthorized)
	}

	select {
	case got := <-followUps:
		t.Fatalf("unverified request triggered a follow-up to %q", got.url)
	default:
	}
}

func TestSlackMeetRejectsForeignResponseURL(t *testing.T) {
	t.Parallel()

	handler, _ := newSlackServer(t)

	for _, target := range []string{
		"http://hooks.slack.com/x",
		"https://attacker.example/x",
		"https://hooks.slack.com.attacker.example/x",
		"",
	} {
		form := slackForm("x")
		form.Set("response_url", target)

		rec := serve(handler, signedSlackRequest(t, slackSecret, form, time.Now()))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%q: got status %d, want %d", target, rec.Code, http.StatusBadRequest)
		}
	}
}

func TestSlackMeetDisabledWithoutSecret(t *testing.T) {
	t.Parallel()

	handler := newTestServer(t)

	rec := serve(handler, signedSlackRequest(t, slackSecret, slackForm("x"), time.Now()))
	if rec.Code != http.StatusNotFound && rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("got status %d, want the route to be absent", rec.Code)
	}
}
