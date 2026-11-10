package service

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/stubbe/conference/internal/speech/vad"
	"github.com/stubbe/conference/internal/speech/wav"
	"github.com/stubbe/conference/internal/speech/wire"
)

const (
	minUtterance = vad.Rate / 4
	queuedFinals = 8
	contextKept  = 5

	// A speaker's own voice is cloned from a sample they recorded: at
	// least 6 s, at most 20 s is kept.
	ownVoiceMax      = 20 * vad.Rate
	ownVoicePrepared = 6 * vad.Rate
)

type voiceFrame struct {
	header wire.VoiceHeader
	pcm    []byte
}

type sender func(message any) error

type final struct {
	seg   int64
	lang  language
	voice voiceChoice
	audio []int16
	// own is the speaker's recorded voice, when they chose it (see ownVoice).
	own *reference
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
	// incoming collects a voice sample the speaker recorded while it
	// arrives (read loop only); prepared is that sample once it is ready.
	incoming []int16
	prepared atomic.Pointer[reference]
}

// voiceTargets are the languages someone wants a translated voice in;
// all means every target, for clients that don't say.
type voiceTargets struct {
	all   bool
	codes []string
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
	voices   atomic.Pointer[voiceTargets]
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
		voices:   atomic.Pointer[voiceTargets]{},
		speaker: &speaker{
			id:             member,
			lang:           language{Code: "", Name: "", Whisper: "", Address: "", Voices: nil},
			voice:          defaultVoice,
			utterances:     utterances,
			seg:            atomic.Int64{},
			finals:         make(chan final, queuedFinals),
			interimBusy:    atomic.Bool{},
			interimSamples: 0,
			context:        nil,
			incoming:       nil,
			prepared:       atomic.Pointer[reference]{},
		},
		pending: atomic.Int64{},
	}
	created.targets.Store(&[]language{})
	created.voices.Store(&voiceTargets{all: true, codes: nil})
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

// setVoiceTargets narrows the translated voices to these languages; nil
// means every target.
func (s *session) setVoiceTargets(codes []string) {
	s.voices.Store(&voiceTargets{all: codes == nil, codes: slices.Clone(codes)})
}

func (s *session) wantsVoice(code string) bool {
	targets := s.voices.Load()

	return targets.all || slices.Contains(targets.codes, code)
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
		err := s.finish(ctx, current, current.utterances.Flush())
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

// sampleAudio collects audio of a voice sample the speaker recorded
// before the call, up to the longest sample kept.
func (s *session) sampleAudio(header wire.AudioHeader, pcm []int16) error {
	current := s.speaker
	if header.Speaker != current.id {
		return fmt.Errorf("%w: %q", errForeignSpeaker, header.Speaker)
	}

	if s.settings.ownVoice() {
		current.incoming = append(current.incoming, pcm[:min(len(pcm), ownVoiceMax-len(current.incoming))]...)
	}

	return nil
}

// finishSample turns the collected voice sample into the speaker's own
// voice: transcribed, so the voice engine gets its text too, and used for
// every translated sentence from then on.
func (s *session) finishSample(ctx context.Context, speakerID, code string) error {
	current := s.speaker
	if speakerID != current.id {
		return fmt.Errorf("%w: %q", errForeignSpeaker, speakerID)
	}

	audio := current.incoming
	current.incoming = nil

	if !s.settings.ownVoice() {
		return nil
	}

	lang, ok := s.settings.languages.get(code)
	if !ok || len(audio) < ownVoicePrepared {
		s.emit(ctx, wire.Notice{Type: wire.TypeNotice, Code: wire.NoticeOwnVoiceRejected, Seconds: seconds(len(audio))})

		return nil
	}

	s.tasks.Go(func() { s.prepare(ctx, current, audio, lang) })

	return nil
}

func (s *session) prepare(ctx context.Context, current *speaker, audio []int16, lang language) {
	text, err := s.engines.transcribe(ctx, audio, lang)
	if err != nil || text == "" {
		if err != nil {
			logFailure(ctx, "own voice sample", err)
		}

		s.emit(ctx, wire.Notice{Type: wire.TypeNotice, Code: wire.NoticeOwnVoiceRejected, Seconds: seconds(len(audio))})

		return
	}

	encoded, err := wav.Encode(audio, vad.Rate)
	if err != nil {
		logFailure(ctx, "own voice sample", err)

		return
	}

	prepared := &reference{wav: encoded, text: text}
	current.prepared.Store(prepared)
	s.emit(ctx, wire.Notice{Type: wire.TypeNotice, Code: wire.NoticeOwnVoiceReady, Seconds: seconds(len(audio))})

	if warmer, ok := s.engines.(voiceWarmer); ok {
		err = warmer.warmVoice(ctx, prepared)
		if err != nil {
			logFailure(ctx, "own voice warm-up", err)
		}
	}
}

// forgetVoice drops the speaker's own voice from this session at once:
// the recorded sample, and one still arriving.
func (s *session) forgetVoice(speakerID string) error {
	current := s.speaker
	if speakerID != current.id {
		return fmt.Errorf("%w: %q", errForeignSpeaker, speakerID)
	}

	current.incoming = nil
	current.prepared.Store(nil)

	return nil
}

func (s *session) end(ctx context.Context, speakerID string) error {
	if speakerID != s.speaker.id {
		return fmt.Errorf("%w: %q", errForeignSpeaker, speakerID)
	}

	return s.finish(ctx, s.speaker, s.speaker.utterances.Flush())
}

func (s *session) close() {
	close(s.speaker.finals)
	s.tasks.Wait()
}

func (s *session) finish(ctx context.Context, current *speaker, audio []int16) error {
	if len(audio) < minUtterance {
		return nil
	}

	job := final{seg: current.seg.Load(), lang: current.lang, voice: current.voice, audio: audio, own: nil}

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

	job.own = s.ownVoice(current, job)

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

// ownVoice is the speaker's recorded voice while they have chosen it,
// or nil for the stock voice.
func (s *session) ownVoice(current *speaker, job final) *reference {
	if !s.settings.ownVoice() || job.voice != voiceOwn {
		return nil
	}

	return current.prepared.Load()
}

func seconds(samples int) float64 {
	return math.Round(float64(samples)/vad.Rate*10) / 10 //nolint:mnd // one decimal
}

func (s *session) translate(ctx context.Context, current *speaker, job final, target language, text string, earlier []string) {
	started := time.Now()

	translated, err := s.engines.translate(ctx, text, job.lang, target, earlier)
	if err != nil {
		logFailure(ctx, "translation, sent the original", err)
		s.emit(ctx, wire.Notice{Type: wire.TypeNotice, Code: wire.NoticeTranslateFailed, Seconds: 0})
		s.caption(ctx, current, job.seg, job.lang, target, text, true)

		return
	}

	s.caption(ctx, current, job.seg, job.lang, target, translated, true)

	if !s.wantsVoice(target.Code) {
		return
	}

	translating := time.Since(started)
	voicing := time.Now()

	spoken, err := s.engines.speak(ctx, translated, target, job.voice, job.own)
	cloned := job.own != nil

	if err != nil && cloned {
		logFailure(ctx, "own voice, spoke in the stock voice", err)

		cloned = false

		if unconverted, ok := errors.AsType[*unconvertedError](err); ok {
			spoken, err = unconverted.stock, nil
		} else {
			spoken, err = s.engines.speak(ctx, translated, target, job.voice, nil)
		}
	}

	if err != nil {
		logFailure(ctx, "voice", err)

		return
	}

	log.Printf("voice lang=%s translate_ms=%d voice_ms=%d convert_ms=%d own=%t",
		target.Code, translating.Milliseconds(), time.Since(voicing).Milliseconds(), spoken.converting.Milliseconds(), cloned)

	s.emit(ctx, voiceFrame{
		header: wire.VoiceHeader{
			Speaker: current.id, SegID: current.segID(job.seg), Lang: target.Code, Rate: spoken.rate, Cloned: cloned,
		},
		pcm: spoken.pcm,
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
