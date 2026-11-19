package service

import (
	"context"
	"errors"
	"fmt"
	"log"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/stubbe/conference/internal/speech/vad"
	"github.com/stubbe/conference/internal/speech/wire"
)

const (
	minUtterance = vad.Rate / 4
	queuedFinals = 8
	contextKept  = 5
)

type voiceFrame struct {
	header wire.VoiceHeader
	pcm    []byte
}

type sender func(message any) error

type final struct {
	event vad.Event
	lang  language
	voice voiceChoice
}

type speaker struct {
	id             string
	lang           language
	voice          voiceChoice
	utterances     *vad.Utterances
	queued         atomic.Int64
	finals         chan final
	lines          lines
	interimBusy    atomic.Bool
	interimSamples int
	context        []string
}

func (s *speaker) segID(seg int64) string {
	return fmt.Sprintf("%s-%d", s.id, seg)
}

type session struct {
	settings Settings
	engines  speechEngines
	send     sender
	tasks    sync.WaitGroup
	targets  atomic.Pointer[[]language]
	speaker  *speaker
	pending  atomic.Int64
}

var errForeignSpeaker = errors.New("speaker is not the member the token was minted for")

func newSession(ctx context.Context, settings Settings, engines speechEngines, member string, send sender) (*session, error) {
	utterances, err := vad.New()
	if err != nil {
		return nil, fmt.Errorf("speaker %s: %w", member, err)
	}

	created := &session{
		settings: settings,
		engines:  engines,
		send:     send,
		tasks:    sync.WaitGroup{},
		targets:  atomic.Pointer[[]language]{},
		speaker: &speaker{
			id:             member,
			lang:           language{Code: "", Name: "", Whisper: "", Address: "", Voices: nil},
			voice:          defaultVoice,
			utterances:     utterances,
			queued:         atomic.Int64{},
			finals:         make(chan final, queuedFinals),
			lines:          lines{mu: sync.Mutex{}, held: "", seq: 0},
			interimBusy:    atomic.Bool{},
			interimSamples: 0,
			context:        nil,
		},
		pending: atomic.Int64{},
	}
	created.targets.Store(&[]language{})
	created.tasks.Go(func() { created.work(ctx, created.speaker) })

	return created, nil
}

func (s *session) setTargets(codes []string) []string {
	targets := make([]language, 0, len(codes))
	accepted := make([]string, 0, len(codes))

	for _, code := range codes {
		lang, ok := s.settings.languages.get(code)
		if !ok || slices.Contains(accepted, code) {
			continue
		}

		targets = append(targets, lang)
		accepted = append(accepted, code)
	}

	s.targets.Store(&targets)

	return accepted
}

func (s *session) audio(ctx context.Context, header wire.AudioHeader, pcm []int16) error {
	current := s.speaker
	if header.Speaker != current.id {
		return fmt.Errorf("%w: %q", errForeignSpeaker, header.Speaker)
	}

	lang, ok := s.settings.languages.get(header.Lang)
	if !ok {
		return nil
	}

	if current.lang.Code != "" && current.lang.Code != lang.Code {
		err := s.stop(ctx, current)
		if err != nil {
			return err
		}
	}

	current.lang = lang
	current.voice = parseVoiceChoice(header.Voice)

	events, err := current.utterances.Push(pcm)
	if err != nil {
		return fmt.Errorf("speaker %s: %w", current.id, err)
	}

	for _, event := range events {
		err = s.finish(ctx, current, event)
		if err != nil {
			return err
		}
	}

	s.maybeInterim(ctx, current)

	return nil
}

func (s *session) end(ctx context.Context, speakerID string) error {
	if speakerID != s.speaker.id {
		return fmt.Errorf("%w: %q", errForeignSpeaker, speakerID)
	}

	return s.stop(ctx, s.speaker)
}

func (s *session) stop(ctx context.Context, current *speaker) error {
	return s.finish(ctx, current, vad.Utterance{Audio: current.utterances.Flush(), Cut: vad.Silence})
}

func (s *session) close() {
	close(s.speaker.finals)
	s.tasks.Wait()
}

func (s *session) finish(ctx context.Context, current *speaker, event vad.Event) error {
	if utterance, ok := event.(vad.Utterance); ok && len(utterance.Audio) < minUtterance {
		if utterance.Cut == vad.Pause {
			return nil
		}

		event = vad.Stopped{}
	}

	job := final{event: event, lang: current.lang, voice: current.voice}

	s.pending.Add(1)
	current.queued.Add(1)
	current.interimSamples = 0

	select {
	case current.finals <- job:
		return nil
	case <-ctx.Done():
		s.pending.Add(-1)

		return fmt.Errorf("speaker %s: queue a sentence: %w", current.id, ctx.Err())
	}
}

func (s *session) maybeInterim(ctx context.Context, current *speaker) {
	if s.settings.interim == 0 || !current.utterances.Active() || s.pending.Load() > 0 {
		return
	}

	grown := time.Duration(current.utterances.Samples()-current.interimSamples) * time.Second / vad.Rate
	if grown < s.settings.interim || !current.interimBusy.CompareAndSwap(false, true) {
		return
	}

	current.interimSamples = current.utterances.Samples()
	queued, lang, audio := current.queued.Load(), current.lang, current.utterances.Audio()

	s.tasks.Go(func() {
		defer current.interimBusy.Store(false)

		text, err := s.engines.transcribe(ctx, audio, lang)
		if err != nil {
			logFailure(ctx, "interim", err)

			return
		}

		if text == "" || current.queued.Load() != queued {
			return
		}

		interim := current.lines.partial(text)
		s.caption(ctx, current, interim.seq, lang, lang, interim.text, false)
	})
}

func (s *session) work(ctx context.Context, current *speaker) {
	for job := range current.finals {
		s.final(ctx, current, job)
		s.pending.Add(-1)
	}
}

func (s *session) final(ctx context.Context, current *speaker, job final) {
	switch event := job.event.(type) {
	case vad.Utterance:
		s.heard(ctx, current, job, event)
	case vad.Stopped:
		s.sentence(ctx, current, job, current.lines.stopped())
	}
}

func (s *session) heard(ctx context.Context, current *speaker, job final, utterance vad.Utterance) {
	started := time.Now()

	text, err := s.engines.transcribe(ctx, utterance.Audio, job.lang)
	if err != nil {
		logFailure(ctx, "final", err)

		return
	}

	transcribed := time.Since(started)

	said, done := current.lines.utterance(text, utterance.Cut)

	switch {
	case done:
		s.sentence(ctx, current, job, said)
	case said.text != "":
		s.caption(ctx, current, said.seq, job.lang, job.lang, said.text, false)
	}

	log.Printf("segment audio_s=%.1f asr_ms=%d total_ms=%d",
		float64(len(utterance.Audio))/vad.Rate, transcribed.Milliseconds(), time.Since(started).Milliseconds())
}

func (s *session) sentence(ctx context.Context, current *speaker, job final, said line) {
	if said.text == "" {
		return
	}

	s.caption(ctx, current, said.seq, job.lang, job.lang, said.text, true)

	earlier := slices.Clone(current.context)
	current.context = append(current.context, said.text)
	current.context = current.context[max(0, len(current.context)-contextKept):]

	var targets sync.WaitGroup

	for _, target := range *s.targets.Load() {
		if target.Code == job.lang.Code {
			continue
		}

		targets.Go(func() { s.translate(ctx, current, job, target, said, earlier) })
	}

	targets.Wait()
}

func (s *session) translate(ctx context.Context, current *speaker, job final, target language, said line, earlier []string) {
	translated, err := s.engines.translate(ctx, said.text, job.lang, target, earlier)
	if err != nil {
		logFailure(ctx, "translation, sent the original", err)
		s.emit(ctx, wire.Notice{Type: wire.TypeNotice, Code: wire.NoticeTranslateFailed, Lang: target.Code})
		s.caption(ctx, current, said.seq, job.lang, target, said.text, true)

		return
	}

	s.caption(ctx, current, said.seq, job.lang, target, translated, true)

	spoken, err := s.engines.speak(ctx, translated, target, job.voice)
	if err != nil {
		logFailure(ctx, "voice", err)
		s.emit(ctx, wire.Notice{Type: wire.TypeNotice, Code: wire.NoticeVoiceFailed, Lang: target.Code})

		return
	}

	s.emit(ctx, voiceFrame{
		header: wire.VoiceHeader{Speaker: current.id, SegID: current.segID(said.seq), Lang: target.Code, Rate: spoken.rate},
		pcm:    spoken.pcm,
	})
}

func (s *session) caption(ctx context.Context, current *speaker, seg int64, source, lang language, text string, isFinal bool) {
	s.emit(ctx, wire.Caption{
		Type:       wire.TypeCaption,
		Speaker:    current.id,
		SegID:      current.segID(seg),
		SourceLang: source.Code,
		Lang:       lang.Code,
		Text:       text,
		Final:      isFinal,
	})
}

func (s *session) emit(ctx context.Context, message any) {
	err := s.send(message)
	if err != nil {
		logFailure(ctx, "send", err)
	}
}

func logFailure(ctx context.Context, stage string, err error) {
	if ctx.Err() != nil {
		return
	}

	log.Printf("%s failed: %v", stage, err)
}
