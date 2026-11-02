package api

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	maxSlackBodyBytes     = 16 << 10
	slackMaxClockSkew     = 5 * time.Minute
	slackFollowUpTimeout  = 10 * time.Second
	slackResponseURLHost  = "hooks.slack.com"
	slackSignatureVersion = "v0"
)

var (
	errSlackResponseURL = errors.New("response_url is not an https://" + slackResponseURLHost + " URL")
	errSlackStatus      = errors.New("slack rejected the follow-up message")
)

//nolint:tagliatelle // Slack defines these snake_case field names.
type slackMessage struct {
	ResponseType    string `json:"response_type"`
	ReplaceOriginal bool   `json:"replace_original"`
	UnfurlLinks     bool   `json:"unfurl_links"`
	Text            string `json:"text"`
}

// slackCommand is a verified slash command invocation.
type slackCommand struct {
	userID      string
	roomName    string
	responseURL *url.URL
}

// slackMeet answers a Slack slash command by creating an open room,
// posting its link to the channel and sending the invoker the
// moderator link privately.
func (s *Server) slackMeet(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxSlackBodyBytes))
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad-request", "Unreadable body.")

		return
	}

	if !validSlackSignature(s.Cfg.SlackSigningSecret, r.Header, body, time.Now()) {
		writeError(w, http.StatusUnauthorized, "bad-signature", "Invalid Slack request signature.")

		return
	}

	form, err := url.ParseQuery(string(body))
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad-request", "Invalid form body.")

		return
	}

	if form.Get("ssl_check") == "1" {
		w.WriteHeader(http.StatusOK)

		return
	}

	cmd, err := parseSlackCommand(form)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad-request", err.Error())

		return
	}

	if len(cmd.roomName) > maxRoomNameLen {
		writeJSON(w, http.StatusOK, ephemeral(fmt.Sprintf("Meeting names can be at most %d characters.", maxRoomNameLen)))

		return
	}

	created, err := s.newRoom(r.Context(), createRoomRequest{Name: cmd.roomName, Password: "", MaxMembers: 0}, s.Cfg.BaseURL)
	if err != nil {
		log.Printf("api: slack: create room: %v", err)
		writeJSON(w, http.StatusOK, ephemeral("Could not create the meeting. Please try again."))

		return
	}

	writeJSON(w, http.StatusOK, slackMessage{
		ResponseType:    "in_channel",
		ReplaceOriginal: false,
		UnfurlLinks:     false,
		Text:            meetingAnnouncement(cmd, created),
	})

	go s.sendSlackFollowUp(context.WithoutCancel(r.Context()), cmd.responseURL, ephemeral(hostNotice(created)))
}

// parseSlackCommand extracts the fields slackMeet relies on and
// validates the follow-up URL Slack supplied.
func parseSlackCommand(form url.Values) (slackCommand, error) {
	responseURL, err := url.Parse(form.Get("response_url"))
	if err != nil || responseURL.Scheme != "https" || responseURL.Host != slackResponseURLHost {
		return slackCommand{}, errSlackResponseURL
	}

	return slackCommand{
		userID:      form.Get("user_id"),
		roomName:    strings.TrimSpace(form.Get("text")),
		responseURL: responseURL,
	}, nil
}

// validSlackSignature checks Slack's v0 request signature: an
// HMAC-SHA256 over "v0:<timestamp>:<body>" keyed with the signing
// secret, with a timestamp no further than slackMaxClockSkew from now.
func validSlackSignature(secret string, header http.Header, body []byte, now time.Time) bool {
	timestamp := header.Get("X-Slack-Request-Timestamp")

	sent, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return false
	}

	skew := now.Sub(time.Unix(sent, 0)).Abs()
	if skew > slackMaxClockSkew {
		return false
	}

	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(slackSignatureVersion + ":" + timestamp + ":"))
	_, _ = mac.Write(body)

	want := slackSignatureVersion + "=" + hex.EncodeToString(mac.Sum(nil))

	return hmac.Equal([]byte(want), []byte(header.Get("X-Slack-Signature")))
}

// sendSlackFollowUp posts msg to the command's response_url. Failures
// can only be logged: the slash command has already been answered.
func (s *Server) sendSlackFollowUp(ctx context.Context, responseURL *url.URL, msg slackMessage) {
	ctx, cancel := context.WithTimeout(ctx, slackFollowUpTimeout)
	defer cancel()

	err := postSlackMessage(ctx, s.SlackClient, responseURL, msg)
	if err != nil {
		log.Printf("api: slack: host link follow-up: %v", err)
	}
}

func postSlackMessage(ctx context.Context, client *http.Client, target *url.URL, msg slackMessage) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("encode message: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("post to %s: %w", slackResponseURLHost, err)
	}

	defer func() { _ = resp.Body.Close() }()

	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, maxSlackBodyBytes))

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%w: status %d", errSlackStatus, resp.StatusCode)
	}

	return nil
}

func ephemeral(text string) slackMessage {
	return slackMessage{ResponseType: "ephemeral", ReplaceOriginal: false, UnfurlLinks: false, Text: text}
}

func meetingAnnouncement(cmd slackCommand, created createRoomResponse) string {
	title := "a meeting"
	if created.Name != "" {
		title = "*" + escapeSlack(created.Name) + "*"
	}

	return fmt.Sprintf("<@%s> started %s: <%s|join> %s", cmd.userID, title, created.ShortURL, created.ShortURL)
}

func hostNotice(created createRoomResponse) string {
	return fmt.Sprintf(
		"<%s|Open as host> to mute, stop cameras or remove people. Only you can see this link; anyone who has it can moderate the meeting.",
		created.PrivURL,
	)
}

// escapeSlack escapes the three characters Slack's mrkdwn treats as
// control sequences.
func escapeSlack(text string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(text)
}
