// Command speechcheck streams the German and English fixtures through a
// running speech service as two speakers at once, and checks that each
// comes back as subtitles and voice in the other language.
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"github.com/stubbe/conference/internal/speech/token"
	"github.com/stubbe/conference/internal/speech/wav"
	"github.com/stubbe/conference/internal/speech/wire"
)

const (
	defaultURL      = "ws://localhost:8090"
	fixturesDir     = "fixtures"
	chunkSamples    = 320
	chunkInterval   = 20 * time.Millisecond
	sampleRate      = 16000
	pcmWidth        = 2
	tokenTTL        = time.Hour
	speakingTimeout = 60 * time.Second
	drainTimeout    = 10 * time.Second
)

type speakerSpec struct {
	id      string
	lang    string
	fixture string
	target  string
	voice   string
	expect  []string
}

func speakers() []speakerSpec {
	return []speakerSpec{
		{id: "anna", lang: "de", fixture: "german.wav", target: "en", voice: "female", expect: []string{"delivery", "Excel"}},
		{id: "sam", lang: "en", fixture: "english.wav", target: "de", voice: "male", expect: []string{"Webshop", "Bildschirm"}},
	}
}

var (
	errBadTokenAccepted = errors.New("a bad token was accepted")
	errFailed           = errors.New("FAIL")
	errNotReady         = errors.New("the service did not answer hello with ready")
	errNoSecret         = errors.New("SPEECH_SECRET must be set")
)

func main() {
	log.SetFlags(0)

	base := defaultURL
	if len(os.Args) > 1 {
		base = os.Args[1]
	}

	err := run(context.Background(), base, os.Getenv("SPEECH_SECRET"))
	if err != nil {
		log.Fatal(err)
	}

	log.Print("PASS")
}

func run(ctx context.Context, base, secret string) error {
	if secret == "" {
		return errNoSecret
	}

	err := rejectsBadToken(ctx, base)
	if err != nil {
		return err
	}

	tok, err := token.Mint([]byte(secret), token.Claims{Room: "test", Member: "host", Exp: time.Now().Add(tokenTTL).Unix()})
	if err != nil {
		return fmt.Errorf("mint a token: %w", err)
	}

	conn, err := connect(ctx, base+"/v1/stream?token="+tok)
	if err != nil {
		return err
	}

	defer func() { _ = conn.CloseNow() }()

	results := listen(ctx, conn, startSpeaking(ctx, conn))

	return results.check()
}

func rejectsBadToken(ctx context.Context, base string) error {
	conn, response, err := websocket.Dial(ctx, base+"/v1/stream?token=bogus", nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}

	if err == nil {
		_ = conn.CloseNow()

		return errBadTokenAccepted
	}

	if response == nil || response.StatusCode != http.StatusForbidden {
		return fmt.Errorf("a bad token: %w", err)
	}

	return nil
}

func connect(ctx context.Context, address string) (*websocket.Conn, error) {
	conn, response, err := websocket.Dial(ctx, address, nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}

	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}

	conn.SetReadLimit(-1)

	err = send(ctx, conn, wire.Command{Type: wire.TypeHello, Targets: []string{"en", "de"}, Speaker: ""})
	if err != nil {
		return nil, err
	}

	_, data, err := conn.Read(ctx)
	if err != nil {
		return nil, fmt.Errorf("read ready: %w", err)
	}

	var reply wire.Command

	if json.Unmarshal(data, &reply) != nil || reply.Type != wire.TypeReady {
		return nil, fmt.Errorf("%w: %s", errNotReady, data)
	}

	return conn, nil
}

func startSpeaking(ctx context.Context, conn *websocket.Conn) *atomic.Int64 {
	speaking := &atomic.Int64{}

	for _, who := range speakers() {
		speaking.Add(1)

		go func() {
			defer speaking.Add(-1)

			err := speak(ctx, conn, who)
			if err != nil {
				log.Printf("%s: %v", who.id, err)
			}
		}()
	}

	return speaking
}

func speak(ctx context.Context, conn *websocket.Conn, who speakerSpec) error {
	data, err := fs.ReadFile(os.DirFS(fixturesDir), who.fixture)
	if err != nil {
		return fmt.Errorf("read %s (run from the repository root): %w", who.fixture, err)
	}

	samples, rate, err := wav.Decode(data)
	if err != nil {
		return fmt.Errorf("decode %s: %w", who.fixture, err)
	}

	if rate != sampleRate {
		return fmt.Errorf("decode %s: %w", who.fixture, errFailed)
	}

	pcm, err := binary.Append(nil, binary.LittleEndian, append(samples, make([]int16, sampleRate)...))
	if err != nil {
		return fmt.Errorf("encode %s: %w", who.fixture, err)
	}

	err = stream(ctx, conn, who, pcm)
	if err != nil {
		return err
	}

	return send(ctx, conn, wire.Command{Type: wire.TypeEnd, Targets: nil, Speaker: who.id})
}

func stream(ctx context.Context, conn *websocket.Conn, who speakerSpec, pcm []byte) error {
	ticker := time.NewTicker(chunkInterval)
	defer ticker.Stop()

	header := wire.AudioHeader{Speaker: who.id, Lang: who.lang, Voice: who.voice}

	for offset := 0; offset < len(pcm); offset += pcmWidth * chunkSamples {
		frame, err := wire.Pack(header, pcm[offset:min(offset+pcmWidth*chunkSamples, len(pcm))])
		if err != nil {
			return fmt.Errorf("pack audio: %w", err)
		}

		err = conn.Write(ctx, websocket.MessageBinary, frame)
		if err != nil {
			return fmt.Errorf("send audio: %w", err)
		}

		<-ticker.C
	}

	return nil
}

func send(ctx context.Context, conn *websocket.Conn, message wire.Command) error {
	encoded, err := json.Marshal(message)
	if err != nil {
		return fmt.Errorf("encode %s: %w", message.Type, err)
	}

	err = conn.Write(ctx, websocket.MessageText, encoded)
	if err != nil {
		return fmt.Errorf("send %s: %w", message.Type, err)
	}

	return nil
}

type key struct {
	speaker string
	lang    string
}

type results struct {
	started  time.Time
	finals   map[key][]string
	voice    map[key]time.Duration
	interims int
}

func listen(ctx context.Context, conn *websocket.Conn, speaking *atomic.Int64) results {
	got := results{started: time.Now(), finals: map[key][]string{}, voice: map[key]time.Duration{}, interims: 0}

	for {
		timeout := speakingTimeout
		if speaking.Load() == 0 {
			timeout = drainTimeout
		}

		readCtx, cancel := context.WithTimeout(ctx, timeout)
		kind, data, err := conn.Read(readCtx)

		cancel()

		if err != nil {
			return got
		}

		if kind == websocket.MessageBinary {
			got.addVoice(data)
		} else {
			got.addCaption(data)
		}
	}
}

func (r *results) addVoice(data []byte) {
	var header wire.VoiceHeader

	pcm, err := wire.Unpack(data, &header)
	if err != nil || header.Rate <= 0 {
		log.Printf("bad voice frame: %v", err)

		return
	}

	length := time.Duration(len(pcm)/pcmWidth) * time.Second / time.Duration(header.Rate)
	r.voice[key{speaker: header.Speaker, lang: header.Lang}] = length

	//nolint:gosec // %q quotes the values, so control characters cannot forge log lines.
	log.Printf("%5.1fs voice   %q [%q] %.1fs", time.Since(r.started).Seconds(), header.Speaker, header.Lang, length.Seconds())
}

func (r *results) addCaption(data []byte) {
	var caption wire.Caption

	if json.Unmarshal(data, &caption) != nil || caption.Type != wire.TypeCaption {
		return
	}

	if !caption.Final {
		r.interims++

		return
	}

	at := key{speaker: caption.Speaker, lang: caption.Lang}
	r.finals[at] = append(r.finals[at], caption.Text)

	log.Printf("%5.1fs caption %q [%q->%q] %q",
		time.Since(r.started).Seconds(), caption.Speaker, caption.SourceLang, caption.Lang, caption.Text)
}

func (r *results) check() error {
	log.Printf("interim captions: %d", r.interims)

	var problems []string

	if r.interims == 0 {
		problems = append(problems, "no interim captions")
	}

	for _, who := range speakers() {
		if len(r.finals[key{speaker: who.id, lang: who.lang}]) == 0 {
			problems = append(problems, who.id+": no caption in "+who.lang)
		}

		translated := strings.ToLower(strings.Join(r.finals[key{speaker: who.id, lang: who.target}], " "))
		for _, word := range who.expect {
			if !strings.Contains(translated, strings.ToLower(word)) {
				problems = append(problems, fmt.Sprintf("%s: %q missing from the %s translation", who.id, word, who.target))
			}
		}

		if _, ok := r.voice[key{speaker: who.id, lang: who.target}]; !ok {
			problems = append(problems, who.id+": no voice in "+who.target)
		}
	}

	if len(problems) > 0 {
		return fmt.Errorf("%w: %s", errFailed, strings.Join(problems, "; "))
	}

	return nil
}
