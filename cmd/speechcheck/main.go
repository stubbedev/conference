// Command speechcheck runs the speech service with the engines the
// environment sets up, streams the German and English fixtures through
// it as two members at once, each on its own connection, and checks that
// each comes back as subtitles and voice in the other language.
package main

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/stubbe/conference/internal/speech/service"
	"github.com/stubbe/conference/internal/speech/wav"
	"github.com/stubbe/conference/internal/speech/wire"
)

const (
	fixturesDir       = "fixtures"
	room              = "speechcheck"
	chunkSamples      = 320
	chunkInterval     = 20 * time.Millisecond
	sampleRate        = 16000
	pcmWidth          = 2
	headerReadTimeout = 10 * time.Second
	speakingTimeout   = 60 * time.Second
	drainTimeout      = 10 * time.Second
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
	errNotSetUp         = errors.New("live translation is not set up")
	errFixtureRate      = errors.New("fixture is not 16 kHz")
)

func main() {
	log.SetFlags(0)

	err := run(context.Background())
	if err != nil {
		log.Fatal(err)
	}

	log.Print("PASS")
}

func run(ctx context.Context) error {
	settings, err := service.FromEnv(os.Getenv)
	if err != nil {
		return fmt.Errorf("speech settings: %w", err)
	}

	if status := settings.Status(); !status.Available {
		return fmt.Errorf("%w: %s", errNotSetUp, status.Reason)
	}

	settings.LogEngines()

	speech := service.New(settings, func(*http.Request) []string { return nil })
	defer speech.Shutdown()

	listener, err := new(net.ListenConfig).Listen(ctx, "tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}

	server := &http.Server{Handler: speech, ReadHeaderTimeout: headerReadTimeout}
	defer func() { _ = server.Close() }()

	go func() { _ = server.Serve(listener) }()

	return checkAll(ctx, "ws://"+listener.Addr().String(), speech)
}

func checkAll(ctx context.Context, base string, speech *service.Service) error {
	err := rejectsBadToken(ctx, base)
	if err != nil {
		return err
	}

	started := time.Now()
	all := speakers()
	outcomes := make([]result, len(all))
	failures := make([]error, len(all))

	var checks sync.WaitGroup

	for i, who := range all {
		checks.Go(func() { outcomes[i], failures[i] = check(ctx, base, speech, who, started) })
	}

	checks.Wait()

	err = errors.Join(failures...)
	if err != nil {
		return err
	}

	return verdict(all, outcomes)
}

func rejectsBadToken(ctx context.Context, base string) error {
	conn, response, err := websocket.Dial(ctx, base+"?token=bogus", nil)
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

func check(ctx context.Context, base string, speech *service.Service, who speakerSpec, started time.Time) (result, error) {
	got := result{finals: map[string][]string{}, voiced: map[string]bool{}, interims: 0}

	tok, err := speech.Token(room, who.id)
	if err != nil {
		return got, fmt.Errorf("%s: %w", who.id, err)
	}

	conn, err := connect(ctx, base+"?token="+tok)
	if err != nil {
		return got, fmt.Errorf("%s: %w", who.id, err)
	}

	defer func() { _ = conn.CloseNow() }()

	spoke := make(chan error, 1)

	go func() { spoke <- speak(ctx, conn, who) }()

	err = listen(ctx, conn, spoke, func(kind websocket.MessageType, data []byte) {
		got.add(kind, data, time.Since(started))
	})
	if err != nil {
		return got, fmt.Errorf("%s: %w", who.id, err)
	}

	return got, nil
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

	err = send(ctx, conn, wire.Command{Type: wire.TypeHello, Targets: []string{"en", "de"}, VoiceTargets: nil, Speaker: ""})
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

type message struct {
	kind websocket.MessageType
	data []byte
}

func readMessages(ctx context.Context, conn *websocket.Conn) <-chan message {
	messages := make(chan message)

	go func() {
		defer close(messages)

		for {
			kind, data, err := conn.Read(ctx)
			if err != nil {
				return
			}

			select {
			case messages <- message{kind: kind, data: data}:
			case <-ctx.Done():
				return
			}
		}
	}()

	return messages
}

func listen(ctx context.Context, conn *websocket.Conn, spoke <-chan error, handle func(websocket.MessageType, []byte)) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	messages := readMessages(ctx, conn)
	timeout := speakingTimeout

	idle := time.NewTimer(timeout)
	defer idle.Stop()

	for {
		select {
		case err := <-spoke:
			if err != nil {
				return err
			}

			spoke, timeout = nil, drainTimeout
			idle.Reset(timeout)
		case got, open := <-messages:
			if !open {
				return nil
			}

			handle(got.kind, got.data)
			idle.Reset(timeout)
		case <-idle.C:
			return nil
		}
	}
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
		return fmt.Errorf("%s at %d Hz: %w", who.fixture, rate, errFixtureRate)
	}

	pcm, err := binary.Append(nil, binary.LittleEndian, append(samples, make([]int16, sampleRate)...))
	if err != nil {
		return fmt.Errorf("encode %s: %w", who.fixture, err)
	}

	err = stream(ctx, conn, who, pcm)
	if err != nil {
		return err
	}

	return send(ctx, conn, wire.Command{Type: wire.TypeEnd, Targets: nil, VoiceTargets: nil, Speaker: who.id})
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

func send(ctx context.Context, conn *websocket.Conn, command wire.Command) error {
	encoded, err := json.Marshal(command)
	if err != nil {
		return fmt.Errorf("encode %s: %w", command.Type, err)
	}

	err = conn.Write(ctx, websocket.MessageText, encoded)
	if err != nil {
		return fmt.Errorf("send %s: %w", command.Type, err)
	}

	return nil
}

type result struct {
	finals   map[string][]string
	voiced   map[string]bool
	interims int
}

func (r *result) add(kind websocket.MessageType, data []byte, elapsed time.Duration) {
	if kind == websocket.MessageBinary {
		r.addVoice(data, elapsed)
	} else {
		r.addCaption(data, elapsed)
	}
}

func (r *result) addVoice(data []byte, elapsed time.Duration) {
	var header wire.VoiceHeader

	pcm, err := wire.Unpack(data, &header)
	if err != nil || header.Rate <= 0 {
		log.Printf("bad voice frame: %v", err)

		return
	}

	length := time.Duration(len(pcm)/pcmWidth) * time.Second / time.Duration(header.Rate)
	r.voiced[header.Lang] = true

	log.Printf("%5.1fs voice   %q [%q] %.1fs", elapsed.Seconds(), header.Speaker, header.Lang, length.Seconds())
}

func (r *result) addCaption(data []byte, elapsed time.Duration) {
	var caption wire.Caption

	if json.Unmarshal(data, &caption) != nil || caption.Type != wire.TypeCaption {
		return
	}

	if !caption.Final {
		r.interims++

		return
	}

	r.finals[caption.Lang] = append(r.finals[caption.Lang], caption.Text)

	log.Printf("%5.1fs caption %q [%q->%q] %q", elapsed.Seconds(), caption.Speaker, caption.SourceLang, caption.Lang, caption.Text)
}

func verdict(all []speakerSpec, outcomes []result) error {
	var problems []string

	for i, who := range all {
		got := outcomes[i]

		log.Printf("%s: %d interim captions", who.id, got.interims)

		if len(got.finals[who.lang]) == 0 {
			problems = append(problems, who.id+": no caption in "+who.lang)
		}

		translated := strings.ToLower(strings.Join(got.finals[who.target], " "))
		for _, word := range who.expect {
			if !strings.Contains(translated, strings.ToLower(word)) {
				problems = append(problems, fmt.Sprintf("%s: %q missing from the %s translation", who.id, word, who.target))
			}
		}

		if !got.voiced[who.target] {
			problems = append(problems, who.id+": no voice in "+who.target)
		}
	}

	if len(problems) > 0 {
		return fmt.Errorf("%w: %s", errFailed, strings.Join(problems, "; "))
	}

	return nil
}
