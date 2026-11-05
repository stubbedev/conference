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
	chunk       = 320
	testTimeout = 30 * time.Second
)

type speakerCase struct {
	id      string
	lang    string
	fixture string
	target  string
}

func testSpeakers() []speakerCase {
	return []speakerCase{
		{id: "anna", lang: "de", fixture: "german.wav", target: "en"},
		{id: "sam", lang: "en", fixture: "english.wav", target: "de"},
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

func mint(t *testing.T, exp time.Time) string {
	t.Helper()

	tok, err := token.Mint([]byte(testSecret), token.Claims{Room: "room", Member: "host", Exp: exp.Unix()})
	if err != nil {
		t.Fatalf("mint: %v", err)
	}

	return tok
}

func fixturePCM(name string) ([]byte, error) {
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

	pcm, err := binary.Append(nil, binary.LittleEndian, append(samples, make([]int16, vad.Rate)...))
	if err != nil {
		return nil, fmt.Errorf("encode %s: %w", name, err)
	}

	return pcm, nil
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

func speak(ctx context.Context, conn *websocket.Conn, who speakerCase) error {
	audio, err := fixturePCM(who.fixture)
	if err != nil {
		return err
	}

	for offset := 0; offset < len(audio); offset += 2 * chunk {
		frame, err := wire.Pack(wire.AudioHeader{Speaker: who.id, Lang: who.lang, Voice: "male"}, audio[offset:min(offset+2*chunk, len(audio))])
		if err != nil {
			return fmt.Errorf("pack audio: %w", err)
		}

		err = conn.Write(ctx, websocket.MessageBinary, frame)
		if err != nil {
			return fmt.Errorf("write audio: %w", err)
		}
	}

	return writeJSONMessage(ctx, conn, map[string]string{"type": "end", "speaker": who.id})
}

func dialStream(ctx context.Context, t *testing.T, server *httptest.Server) *websocket.Conn {
	t.Helper()

	conn, response, err := websocket.Dial(ctx, streamURL(server, mint(t, time.Now().Add(time.Hour))), nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}

	if err != nil {
		t.Fatalf("dial: %v", err)
	}

	t.Cleanup(func() { _ = conn.CloseNow() })

	conn.SetReadLimit(-1)

	err = writeJSONMessage(ctx, conn, map[string]any{"type": "hello", "targets": []string{"en", "de", "xx"}})
	if err != nil {
		t.Fatalf("hello: %v", err)
	}

	var ready struct {
		Type string `json:"type"`
	}

	_, data, err := conn.Read(ctx)
	if err != nil || json.Unmarshal(data, &ready) != nil || ready.Type != "ready" {
		t.Fatalf("first reply %q (%v), want ready", data, err)
	}

	return conn
}

type streamResults struct {
	translated map[string]bool
	voiced     map[string]bool
}

func (r streamResults) done(speakers int) bool {
	return len(r.translated) == speakers && len(r.voiced) == speakers
}

func TestStreamTranslatesBothWays(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithTimeout(t.Context(), testTimeout)
	defer cancel()

	conn := dialStream(ctx, t, start(t, map[string]string{envEngines: enginesFake}))
	speakers := testSpeakers()
	spoke := make(chan error, len(speakers))

	for _, who := range speakers {
		go func() { spoke <- speak(ctx, conn, who) }()
	}

	results := streamResults{translated: map[string]bool{}, voiced: map[string]bool{}}

	for !results.done(len(speakers)) {
		kind, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("read: %v (results %+v)", err, results)
		}

		if kind == websocket.MessageBinary {
			checkVoice(t, data, results)
		} else {
			checkCaption(t, data, results)
		}
	}

	for range speakers {
		err := <-spoke
		if err != nil {
			t.Fatalf("speak: %v", err)
		}
	}
}

func checkVoice(t *testing.T, data []byte, results streamResults) {
	t.Helper()

	var header wire.VoiceHeader

	pcm, err := wire.Unpack(data, &header)
	if err != nil || len(pcm) == 0 || header.Rate != vad.Rate {
		t.Fatalf("voice frame %+v with %d bytes: %v", header, len(pcm), err)
	}

	checkTarget(t, header.Speaker, header.Lang)

	results.voiced[header.Speaker] = true
}

func checkCaption(t *testing.T, data []byte, results streamResults) {
	t.Helper()

	var got wire.Caption

	err := json.Unmarshal(data, &got)
	if err != nil {
		t.Fatalf("parse %q: %v", data, err)
	}

	if got.Type != wire.TypeCaption || !got.Final || got.Lang == got.SourceLang {
		return
	}

	checkTarget(t, got.Speaker, got.Lang)

	if want := "[" + got.Lang + "] " + got.SourceLang + " utterance"; !strings.HasPrefix(got.Text, want) {
		t.Fatalf("caption %q, want it to start with %q", got.Text, want)
	}

	if !strings.HasPrefix(got.SegID, got.Speaker+"-") {
		t.Fatalf("segment id %q does not belong to %s", got.SegID, got.Speaker)
	}

	results.translated[got.Speaker] = true
}

func checkTarget(t *testing.T, speaker, lang string) {
	t.Helper()

	for _, who := range testSpeakers() {
		if who.id == speaker && who.target == lang {
			return
		}
	}

	t.Fatalf("%s translated into %s, which is not the other speaker's language", speaker, lang)
}

func TestStreamRefusals(t *testing.T) {
	t.Parallel()

	ready := start(t, map[string]string{envEngines: enginesFake})
	unready := start(t, nil)

	cases := []struct {
		name   string
		server *httptest.Server
		token  string
		status int
	}{
		{name: "bad token", server: ready, token: "bogus", status: http.StatusForbidden},
		{name: "expired token", server: ready, token: mint(t, time.Now().Add(-time.Minute)), status: http.StatusForbidden},
		{name: "engines not set up", server: unready, token: mint(t, time.Now().Add(time.Hour)), status: http.StatusServiceUnavailable},
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

	var got status

	err = json.NewDecoder(response.Body).Decode(&got)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}

	transcribe := got.Engines[transcription]
	if got.Ready || !got.External || transcribe.Ready || !strings.Contains(transcribe.Problem, envTranscribeModel) {
		t.Fatalf("status %+v, want not ready, external, transcription missing its model", got)
	}

	if !got.Engines[translation].Ready || got.Languages[0] != (languageStatus{Code: "en", Name: "English"}) {
		t.Fatalf("status %+v, want translation ready and English first", got)
	}
}

var errUnexpectedRate = errors.New("fixture is not at the VAD rate")
