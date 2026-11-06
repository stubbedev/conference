package service

import (
	"context"
	"errors"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/stubbe/conference/internal/speech/vad"
	"github.com/stubbe/conference/internal/speech/wire"
)

const sessionTimeout = 10 * time.Second

var errEngineDown = errors.New("engine down")

type stubEngines struct {
	transcribeFn func(ctx context.Context, lang language) (string, error)
	translateFn  func(text string, target language) (string, error)
}

func (s stubEngines) transcribe(ctx context.Context, _ []int16, lang language) (string, error) {
	return s.transcribeFn(ctx, lang)
}

func (s stubEngines) translate(_ context.Context, text string, _, target language, _ []string) (string, error) {
	return s.translateFn(text, target)
}

func (stubEngines) speak(context.Context, string, language, voiceChoice, *reference) (speech, error) {
	return speech{pcm: []byte{0, 0}, rate: vad.Rate}, nil
}

type outbox struct {
	mu       sync.Mutex
	messages []any
	arrived  chan struct{}
}

func newOutbox() *outbox {
	return &outbox{mu: sync.Mutex{}, messages: nil, arrived: make(chan struct{}, 1)}
}

func (o *outbox) send(_ context.Context, message any) error {
	o.mu.Lock()
	o.messages = append(o.messages, message)
	o.mu.Unlock()

	select {
	case o.arrived <- struct{}{}:
	default:
	}

	return nil
}

func (o *outbox) snapshot() []any {
	o.mu.Lock()
	defer o.mu.Unlock()

	return append([]any(nil), o.messages...)
}

func (o *outbox) waitFor(t *testing.T, match func(any) bool) {
	t.Helper()

	deadline := time.After(sessionTimeout)

	for {
		if slices.ContainsFunc(o.snapshot(), match) {
			return
		}

		select {
		case <-o.arrived:
		case <-deadline:
			t.Fatalf("no matching message among %+v", o.snapshot())
		}
	}
}

func finalCaption(lang string) func(any) bool {
	return func(message any) bool {
		got, ok := message.(wire.Caption)

		return ok && got.Final && got.Lang == lang
	}
}

func openSession(ctx context.Context, t *testing.T, values map[string]string, engines speechEngines) (*session, *outbox) {
	t.Helper()

	out := newOutbox()

	opened, err := newSession(ctx, load(t, values), engines, anna, out.send)
	if err != nil {
		t.Fatalf("session: %v", err)
	}

	opened.setTargets([]string{"de", "en"})

	return opened, out
}

func speakUntilSpeaking(ctx context.Context, t *testing.T, opened *session, lang string) {
	t.Helper()

	samples, err := fixtureSamples("german.wav")
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}

	header := wire.AudioHeader{Speaker: anna, Lang: lang, Voice: "", Sample: false}

	for offset := 0; offset < len(samples); offset += chunk {
		err = opened.audio(ctx, header, samples[offset:min(offset+chunk, len(samples))])
		if err != nil {
			t.Fatalf("audio: %v", err)
		}

		if opened.speaker.utterances.Samples() >= vad.Rate/2 {
			return
		}
	}

	t.Fatal("the fixture never started an utterance")
}

func echoTranscripts(_ context.Context, lang language) (string, error) {
	return "said in " + lang.Code, nil
}

func echoTranslations(text string, target language) (string, error) {
	return target.Code + ": " + text, nil
}

func TestLanguageSwitchEndsTheSentenceInTheOldLanguage(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(t.Context())
	opened, out := openSession(ctx, t, map[string]string{envEngines: enginesFake, envInterim: "0"},
		stubEngines{transcribeFn: echoTranscripts, translateFn: echoTranslations})

	defer func() { cancel(); opened.close() }()

	speakUntilSpeaking(ctx, t, opened, "de")

	err := opened.audio(ctx, wire.AudioHeader{Speaker: anna, Lang: "en", Voice: "", Sample: false}, make([]int16, chunk))
	if err != nil {
		t.Fatalf("audio: %v", err)
	}

	out.waitFor(t, func(message any) bool {
		got, ok := message.(wire.Caption)

		return ok && got.Final && got.SourceLang == "de" && got.Lang == "de" && got.Text == "said in de"
	})
}

func TestEndSendsTheSentenceSoFar(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(t.Context())
	opened, out := openSession(ctx, t, map[string]string{envEngines: enginesFake, envInterim: "0"},
		stubEngines{transcribeFn: echoTranscripts, translateFn: echoTranslations})

	defer func() { cancel(); opened.close() }()

	speakUntilSpeaking(ctx, t, opened, "de")

	err := opened.end(ctx, anna)
	if err != nil {
		t.Fatalf("end: %v", err)
	}

	out.waitFor(t, finalCaption("en"))

	if opened.speaker.utterances.Active() {
		t.Fatal("the utterance is still open after end")
	}

	err = opened.end(ctx, sam)
	if !errors.Is(err, errForeignSpeaker) {
		t.Fatalf("end for another member: %v, want %v", err, errForeignSpeaker)
	}
}

func TestFailedTranslationSendsTheOriginal(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(t.Context())
	opened, out := openSession(ctx, t, map[string]string{envEngines: enginesFake, envInterim: "0"},
		stubEngines{
			transcribeFn: echoTranscripts,
			translateFn:  func(string, language) (string, error) { return "", errEngineDown },
		})

	speakUntilSpeaking(ctx, t, opened, "de")

	err := opened.end(ctx, anna)
	if err != nil {
		t.Fatalf("end: %v", err)
	}

	out.waitFor(t, finalCaption("en"))
	cancel()
	opened.close()

	noticed := false

	for _, message := range out.snapshot() {
		switch got := message.(type) {
		case wire.Notice:
			noticed = got.Code == wire.NoticeTranslateFailed
		case wire.Caption:
			if got.Lang == "en" && got.Text != "said in de" {
				t.Fatalf("English caption %q, want the untranslated original", got.Text)
			}
		case voiceFrame:
			t.Fatal("a voice was sent for a sentence that was not translated")
		}
	}

	if !noticed {
		t.Fatalf("no translation-failed notice among %+v", out.snapshot())
	}
}

func TestInterimForAnEndedSentenceIsDropped(t *testing.T) {
	t.Parallel()

	interimStarted := make(chan struct{})
	releaseInterim := make(chan struct{})

	var calls sync.Mutex

	first := true

	ctx, cancel := context.WithCancel(t.Context())
	opened, out := openSession(ctx, t, map[string]string{envEngines: enginesFake, envInterim: "50"}, stubEngines{
		transcribeFn: func(context.Context, language) (string, error) {
			calls.Lock()
			isFirst := first
			first = false
			calls.Unlock()

			if !isFirst {
				return "final words", nil
			}

			close(interimStarted)
			<-releaseInterim

			return "interim words", nil
		},
		translateFn: echoTranslations,
	})

	speakUntilInterim(ctx, t, opened, interimStarted)

	err := opened.end(ctx, anna)
	if err != nil {
		t.Fatalf("end: %v", err)
	}

	out.waitFor(t, finalCaption("de"))
	close(releaseInterim)
	cancel()
	opened.close()

	for _, message := range out.snapshot() {
		if got, ok := message.(wire.Caption); ok && !got.Final {
			t.Fatalf("interim caption %+v sent after its sentence ended", got)
		}
	}
}

func speakUntilInterim(ctx context.Context, t *testing.T, opened *session, started <-chan struct{}) {
	t.Helper()

	samples, err := fixtureSamples("german.wav")
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}

	header := wire.AudioHeader{Speaker: anna, Lang: "de", Voice: "", Sample: false}

	for offset := 0; offset < len(samples); offset += chunk {
		err = opened.audio(ctx, header, samples[offset:min(offset+chunk, len(samples))])
		if err != nil {
			t.Fatalf("audio: %v", err)
		}

		select {
		case <-started:
			if opened.speaker.utterances.Samples() >= vad.Rate/2 {
				return
			}
		default:
		}
	}

	t.Fatal("no interim transcription started within half a second of speech")
}

func TestFullQueueHoldsBackAudio(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(t.Context())
	opened, _ := openSession(ctx, t, map[string]string{envEngines: enginesFake, envInterim: "0"}, stubEngines{
		transcribeFn: func(ctx context.Context, _ language) (string, error) {
			<-ctx.Done()

			return "", ctx.Err()
		},
		translateFn: echoTranslations,
	})

	defer func() { cancel(); opened.close() }()

	sentence := make([]int16, minUtterance)
	queued := 0

	for range queuedFinals + 2 {
		finishCtx, stop := context.WithTimeout(ctx, 200*time.Millisecond)
		err := opened.finish(finishCtx, opened.speaker, sentence)

		stop()

		if err != nil {
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("finish: %v, want it held back until the deadline", err)
			}

			break
		}

		queued++
	}

	if queued < queuedFinals || queued > queuedFinals+1 {
		t.Fatalf("%d sentences accepted before audio was held back, want %d or %d", queued, queuedFinals, queuedFinals+1)
	}
}
