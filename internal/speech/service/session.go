package service

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"slices"
	"strings"
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

	// A speaker's own voice is cloned from 12 to 20 s of their finished
	// sentences; shorter ones, such as fillers, don't count.
	ownVoiceMin      = 12 * vad.Rate
	ownVoiceMax      = 20 * vad.Rate
	ownVoiceSentence = vad.Rate
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
	// own is the speaker's own voice once it is learned (see learn).
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
	sample         voiceSample
}

// voiceSample collects a speaker's own voice from their finished
// sentences in one language until it is long enough to clone. It lives
// only in this session's memory and goes with it.
type voiceSample struct {
	lang  string
	audio []int16
	texts []string
	ready *reference
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
			sample:         voiceSample{lang: "", audio: nil, texts: nil, ready: nil},
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

	job.own = s.learn(ctx, current, job, text)

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

// learn adds a finished sentence to the speaker's own-voice sample while
// they have chosen their own voice, and returns the reference once it is
// long enough (nil before, or without a cloning voice engine).
func (s *session) learn(ctx context.Context, current *speaker, job final, text string) *reference {
	if !s.settings.voiceCloning || job.voice != voiceOwn {
		return nil
	}

	sample := &current.sample
	if sample.lang != job.lang.Code {
		*sample = voiceSample{lang: job.lang.Code, audio: nil, texts: nil, ready: nil}
	}

	if sample.ready != nil {
		return sample.ready
	}

	if len(job.audio) < ownVoiceSentence {
		return nil
	}

	sample.audio = append(sample.audio, job.audio[:min(len(job.audio), ownVoiceMax-len(sample.audio))]...)
	sample.texts = append(sample.texts, text)

	if len(sample.audio) < ownVoiceMin {
		s.emit(ctx, wire.Notice{Type: wire.TypeNotice, Code: wire.NoticeOwnVoiceLearning, Seconds: seconds(len(sample.audio))})

		return nil
	}

	encoded, err := wav.Encode(sample.audio, vad.Rate)
	if err != nil {
		logFailure(ctx, "own voice", err)

		return nil
	}

	sample.ready = &reference{wav: encoded, text: strings.Join(sample.texts, " ")}
	sample.audio, sample.texts = nil, nil

	s.emit(ctx, wire.Notice{Type: wire.TypeNotice, Code: wire.NoticeOwnVoiceReady, Seconds: 0})

	return sample.ready
}

func seconds(samples int) float64 {
	return math.Round(float64(samples)/vad.Rate*10) / 10 //nolint:mnd // one decimal
}

func (s *session) translate(ctx context.Context, current *speaker, job final, target language, text string, earlier []string) {
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

	spoken, err := s.engines.speak(ctx, translated, target, job.voice, job.own)
	cloned := job.own != nil

	if err != nil && cloned {
		logFailure(ctx, "own voice, spoke in the stock voice", err)

		spoken, err = s.engines.speak(ctx, translated, target, job.voice, nil)
		cloned = false
	}

	if err != nil {
		logFailure(ctx, "voice", err)

		return
	}

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
