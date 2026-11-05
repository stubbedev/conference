package service

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/stubbe/conference/internal/speech/token"
	"github.com/stubbe/conference/internal/speech/vad"
	"github.com/stubbe/conference/internal/speech/wav"
	"github.com/stubbe/conference/internal/speech/wire"
)

const (
	testSecret  = "s"
	testRoom    = "room"
	chunk       = 320
	testTimeout = 30 * time.Second
	anna        = "anna"
	sam         = "sam"
)

var errUnexpectedRate = errors.New("fixture is not at the VAD rate")

type speakerCase struct {
	id      string
	lang    string
	fixture string
	target  string
}

func testSpeakers() []speakerCase {
	return []speakerCase{
		{id: anna, lang: "de", fixture: "german.wav", target: "en"},
		{id: sam, lang: "en", fixture: "english.wav", target: "de"},
	}
}

func start(t *testing.T, values map[string]string) *httptest.Server {
	t.Helper()

	speech := New(load(t, values))
	server := httptest.NewServer(speech.Handler())

	t.Cleanup(func() {
		server.Close()
		speech.Wait()
	})

	return server
}

func streamURL(server *httptest.Server, tok string) string {
	return "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/stream?token=" + tok
}

func mint(t *testing.T, member string, exp time.Time) string {
	t.Helper()

	tok, err := token.Mint([]byte(testSecret), token.Claims{Room: testRoom, Member: member, Exp: exp.Unix()})
	if err != nil {
		t.Fatalf("mint: %v", err)
	}

	return tok
}

func fixtureSamples(name string) ([]int16, error) {
	data, err := fs.ReadFile(os.DirFS("../../../fixtures"), name)
	if err != nil {
		return nil, fmt.Errorf("read fixture %s: %w", name, err)
	}

	samples, rate, err := wav.Decode(data)
	if err != nil {
		return nil, fmt.Errorf("decode %s: %w", name, err)
	}

	if rate != vad.Rate {
		return nil, fmt.Errorf("%s is %d Hz: %w", name, rate, errUnexpectedRate)
	}

	return samples, nil
}

func writeJSONMessage(ctx context.Context, conn *websocket.Conn, message any) error {
	encoded, err := json.Marshal(message)
	if err != nil {
		return fmt.Errorf("encode: %w", err)
	}

	err = conn.Write(ctx, websocket.MessageText, encoded)
	if err != nil {
		return fmt.Errorf("write: %w", err)
	}

	return nil
}

func sendAudio(ctx context.Context, conn *websocket.Conn, header wire.AudioHeader, samples []int16) error {
	pcm, err := binary.Append(nil, binary.LittleEndian, samples)
	if err != nil {
		return fmt.Errorf("encode audio: %w", err)
	}

	frame, err := wire.Pack(header, pcm)
	if err != nil {
		return fmt.Errorf("pack audio: %w", err)
	}

	err = conn.Write(ctx, websocket.MessageBinary, frame)
	if err != nil {
		return fmt.Errorf("write audio: %w", err)
	}

	return nil
}

func speak(ctx context.Context, conn *websocket.Conn, who speakerCase) error {
	samples, err := fixtureSamples(who.fixture)
	if err != nil {
		return err
	}

	samples = append(samples, make([]int16, vad.Rate)...)
	header := wire.AudioHeader{Speaker: who.id, Lang: who.lang, Voice: string(voiceMale)}

	for offset := 0; offset < len(samples); offset += chunk {
		err = sendAudio(ctx, conn, header, samples[offset:min(offset+chunk, len(samples))])
		if err != nil {
			return err
		}
	}

	return writeJSONMessage(ctx, conn, wire.Command{Type: wire.TypeEnd, Targets: nil, Speaker: who.id})
}

func dialStream(ctx context.Context, t *testing.T, server *httptest.Server, member string) *websocket.Conn {
	t.Helper()

	conn, response, err := websocket.Dial(ctx, streamURL(server, mint(t, member, time.Now().Add(time.Hour))), nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}

	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	t.Cleanup(func() { _ = conn.CloseNow() })

	conn.SetReadLimit(-1)
	hello(ctx, t, conn)

	return conn
}

func hello(ctx context.Context, t *testing.T, conn *websocket.Conn) {
	t.Helper()

	err := writeJSONMessage(ctx, conn, wire.Command{Type: wire.TypeHello, Targets: []string{"en", "de", "xx"}, Speaker: ""})
	if err != nil {
		t.Fatalf("hello: %v", err)
	}

	var ready wire.Command

	_, data, err := conn.Read(ctx)
	if err != nil || json.Unmarshal(data, &ready) != nil || ready.Type != wire.TypeReady {
		t.Fatalf("reply to hello %q (%v), want ready", data, err)
	}
}

func TestStreamTranslatesBothWays(t *testing.T) {
	t.Parallel()

	server := start(t, map[string]string{envEngines: enginesFake})

	for _, who := range testSpeakers() {
		t.Run(who.id, func(t *testing.T) {
			t.Parallel()

			ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
			defer cancel()

			conn := dialStream(ctx, t, server, who.id)
			spoke := make(chan error, 1)

			go func() { spoke <- speak(ctx, conn, who) }()

			translated, voiced := false, false
			for !translated || !voiced {
				kind, data, err := conn.Read(ctx)
				if err != nil {
					t.Fatalf("read: %v (translated %v, voiced %v)", err, translated, voiced)
				}

				if kind == websocket.MessageBinary {
					voiced = voiced || isVoiceFor(t, data, who)
				} else {
					translated = translated || isTranslationFor(t, data, who)
				}
			}

			err := <-spoke
			if err != nil {
				t.Fatalf("speak: %v", err)
			}
		})
	}
}

func isVoiceFor(t *testing.T, data []byte, who speakerCase) bool {
	t.Helper()

	var header wire.VoiceHeader

	pcm, err := wire.Unpack(data, &header)
	if err != nil || len(pcm) == 0 || header.Rate != vad.Rate {
		t.Fatalf("voice frame %+v with %d bytes: %v", header, len(pcm), err)
	}

	if header.Speaker != who.id || header.Lang != who.target {
		t.Fatalf("voice of %s in %s, want %s in %s", header.Speaker, header.Lang, who.id, who.target)
	}

	return true
}

func isTranslationFor(t *testing.T, data []byte, who speakerCase) bool {
	t.Helper()

	var got wire.Caption

	err := json.Unmarshal(data, &got)
	if err != nil {
		t.Fatalf("parse %q: %v", data, err)
	}

	if got.Type != wire.TypeCaption || !got.Final || got.Lang == got.SourceLang {
		return false
	}

	if got.Speaker != who.id || got.SourceLang != who.lang || got.Lang != who.target {
		t.Fatalf("caption %+v, want %s from %s into %s", got, who.id, who.lang, who.target)
	}

	if want := "[" + got.Lang + "] " + got.SourceLang + " utterance"; !strings.HasPrefix(got.Text, want) {
		t.Fatalf("caption %q, want it to start with %q", got.Text, want)
	}

	if !strings.HasPrefix(got.SegID, got.Speaker+"-") {
		t.Fatalf("segment id %q does not belong to %s", got.SegID, got.Speaker)
	}

	return true
}

func closeStatus(ctx context.Context, conn *websocket.Conn) websocket.StatusCode {
	for {
		_, _, err := conn.Read(ctx)
		if err != nil {
			return websocket.CloseStatus(err)
		}
	}
}

func TestForeignSpeakerEndsTheStream(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
	defer cancel()

	conn := dialStream(ctx, t, start(t, map[string]string{envEngines: enginesFake}), anna)

	err := sendAudio(ctx, conn, wire.AudioHeader{Speaker: sam, Lang: "en", Voice: ""}, make([]int16, chunk))
	if err != nil {
		t.Fatalf("send: %v", err)
	}

	if code := closeStatus(ctx, conn); code != websocket.StatusPolicyViolation {
		t.Fatalf("closed with %v, want a policy violation", code)
	}
}

func TestNewConnectionReplacesTheMembersOld(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
	defer cancel()

	server := start(t, map[string]string{envEngines: enginesFake})
	first := dialStream(ctx, t, server, anna)
	other := dialStream(ctx, t, server, sam)
	second := dialStream(ctx, t, server, anna)

	if code := closeStatus(ctx, first); code != websocket.StatusPolicyViolation {
		t.Fatalf("the replaced stream closed with %v, want a policy violation", code)
	}

	hello(ctx, t, second)
	hello(ctx, t, other)
}

func TestStreamRefusals(t *testing.T) {
	t.Parallel()

	ready := start(t, map[string]string{envEngines: enginesFake})
	unready := start(t, nil)
	valid := time.Now().Add(time.Hour)

	cases := []struct {
		name   string
		server *httptest.Server
		token  string
		status int
	}{
		{name: "bad token", server: ready, token: "bogus", status: http.StatusForbidden},
		{name: "expired token", server: ready, token: mint(t, anna, time.Now().Add(-time.Minute)), status: http.StatusForbidden},
		{name: "engines not set up", server: unready, token: mint(t, anna, valid), status: http.StatusServiceUnavailable},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			conn, response, err := websocket.Dial(t.Context(), streamURL(tc.server, tc.token), nil)
			if response != nil && response.Body != nil {
				_ = response.Body.Close()
			}

			if err == nil {
				_ = conn.CloseNow()

				t.Fatal("connected, want a refusal")
			}

			if response == nil || response.StatusCode != tc.status {
				t.Fatalf("response %v, want status %d", response, tc.status)
			}
		})
	}
}

func TestStatus(t *testing.T) {
	t.Parallel()

	server := start(t, map[string]string{envTranslateModel: "m"})

	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, server.URL+"/v1/status", nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("status: %v", err)
	}

	defer func() { _ = response.Body.Close() }()

	var got wire.Status

	err = json.NewDecoder(response.Body).Decode(&got)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}

	transcribe := got.Engines[string(transcription)]
	if got.Ready || !got.External || transcribe.Ready || !strings.Contains(transcribe.Problem, envTranscribeModel) {
		t.Fatalf("status %+v, want not ready, external, transcription missing its model", got)
	}

	if !got.Engines[string(translation)].Ready || got.Languages[0] != (wire.Language{Code: "en", Name: "English"}) {
		t.Fatalf("status %+v, want translation ready and English first", got)
	}
}
