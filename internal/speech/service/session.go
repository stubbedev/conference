package service

import (
	"context"
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

type sender func(ctx context.Context, message any) error

type final struct {
	seg   int64
	lang  language
	voice voiceChoice
	audio []int16
}

type speaker struct {
	id             string
	lang           language
	voice          voiceChoice
	utterances     *vad.Utterances
	seg            atomic.Int64
	finals         chan final
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
	speakers map[string]*speaker
	pending  atomic.Int64
}

func newSession(settings Settings, engines speechEngines, send sender) *session {
	created := &session{
		settings: settings,
		engines:  engines,
		send:     send,
		tasks:    sync.WaitGroup{},
		targets:  atomic.Pointer[[]language]{},
		speakers: map[string]*speaker{},
		pending:  atomic.Int64{},
	}
	created.targets.Store(&[]language{})

	return created
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
	lang, ok := s.settings.languages.get(header.Lang)
	if !ok || header.Speaker == "" {
		return nil
	}

	current, err := s.speaker(ctx, header.Speaker)
	if err != nil {
		return err
	}

	if current.lang.Code != "" && current.lang.Code != lang.Code {
		err = s.finish(ctx, current, current.utterances.Flush())
		if err != nil {
			return err
		}
	}

	current.lang = lang
	current.voice = parseVoiceChoice(header.Voice)

	done, err := current.utterances.Push(pcm)
	if err != nil {
		return fmt.Errorf("speaker %s: %w", current.id, err)
	}

	for _, utterance := range done {
		err = s.finish(ctx, current, utterance)
		if err != nil {
			return err
		}
	}

	s.maybeInterim(ctx, current)

	return nil
}

func (s *session) end(ctx context.Context, speakerID string) error {
	current, ok := s.speakers[speakerID]
	if !ok {
		return nil
	}

	return s.finish(ctx, current, current.utterances.Flush())
}

func (s *session) close() {
	for _, current := range s.speakers {
		close(current.finals)
	}

	s.tasks.Wait()
}

func (s *session) speaker(ctx context.Context, id string) (*speaker, error) {
	if current, ok := s.speakers[id]; ok {
		return current, nil
	}

	utterances, err := vad.New(s.settings.silence, s.settings.maxSegment)
	if err != nil {
		return nil, fmt.Errorf("speaker %s: %w", id, err)
	}

	current := &speaker{
		id:             id,
		lang:           language{Code: "", Name: "", Whisper: "", Address: "", Voices: nil},
		voice:          defaultVoice,
		utterances:     utterances,
		seg:            atomic.Int64{},
		finals:         make(chan final, queuedFinals),
		interimBusy:    atomic.Bool{},
		interimSamples: 0,
		context:        nil,
	}
	s.speakers[id] = current

	s.tasks.Go(func() { s.work(ctx, current) })

	return current, nil
}

func (s *session) finish(ctx context.Context, current *speaker, audio []int16) error {
	if len(audio) < minUtterance {
		return nil
	}

	job := final{seg: current.seg.Load(), lang: current.lang, voice: current.voice, audio: audio}

	s.pending.Add(1)
	current.seg.Add(1)
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
	seg, lang, audio := current.seg.Load(), current.lang, current.utterances.Audio()

	s.tasks.Go(func() {
		defer current.interimBusy.Store(false)

		text, err := s.engines.transcribe(ctx, audio, lang)
		if err != nil {
			logFailure(ctx, "interim", err)

			return
		}

		if text == "" || current.seg.Load() != seg {
			return
		}

		s.caption(ctx, current, seg, lang, lang, text, false)
	})
}

func (s *session) work(ctx context.Context, current *speaker) {
	for job := range current.finals {
		s.final(ctx, current, job)
		s.pending.Add(-1)
	}
}

func (s *session) final(ctx context.Context, current *speaker, job final) {
	started := time.Now()

	text, err := s.engines.transcribe(ctx, job.audio, job.lang)
	if err != nil {
		logFailure(ctx, "final", err)

		return
	}

	transcribed := time.Since(started)

	if text == "" {
		return
	}

	s.caption(ctx, current, job.seg, job.lang, job.lang, text, true)

	earlier := slices.Clone(current.context)
	current.context = append(current.context, text)
	current.context = current.context[max(0, len(current.context)-contextKept):]

	var targets sync.WaitGroup

	for _, target := range *s.targets.Load() {
		if target.Code == job.lang.Code {
			continue
		}

		targets.Go(func() { s.translate(ctx, current, job, target, text, earlier) })
	}

	targets.Wait()

	log.Printf("segment audio_s=%.1f asr_ms=%d total_ms=%d",
		float64(len(job.audio))/vad.Rate, transcribed.Milliseconds(), time.Since(started).Milliseconds())
}

func (s *session) translate(ctx context.Context, current *speaker, job final, target language, text string, earlier []string) {
	translated, err := s.engines.translate(ctx, text, job.lang, target, earlier)
	if err != nil {
		logFailure(ctx, "translation, sent the original", err)
		s.emit(ctx, wire.Notice{Type: wire.TypeNotice, Code: wire.NoticeTranslateFailed})
		s.caption(ctx, current, job.seg, job.lang, target, text, true)

		return
	}

	s.caption(ctx, current, job.seg, job.lang, target, translated, true)

	spoken, err := s.engines.speak(ctx, translated, target, job.voice)
	if err != nil {
		logFailure(ctx, "voice", err)

		return
	}

	s.emit(ctx, voiceFrame{
		header: wire.VoiceHeader{Speaker: current.id, SegID: current.segID(job.seg), Lang: target.Code, Rate: spoken.rate},
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
	err := s.send(ctx, message)
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
