// Package vad cuts a stream of 16 kHz speech into utterances with the
// Silero voice activity model.
package vad

import (
	"fmt"
	"time"

	silerovad "github.com/vithnilica/go-silerovad"
)

// Rate is the sample rate, in Hz, of the audio Utterances takes.
const Rate = silerovad.SampleRate

// MaxUtterance is the longest an utterance runs before it is cut.
const MaxUtterance = 12 * time.Second

const (
	frame          = silerovad.ChunkSize
	startProb      = 0.5
	endProb        = 0.35
	prerollFrames  = 10
	silence        = 400 * time.Millisecond
	longSpeech     = 3 * time.Second
	shortSilence   = 160 * time.Millisecond
	sampleScale    = 32768
	endFrames      = int(silence*Rate/time.Second) / frame
	shortEndFrames = int(shortSilence*Rate/time.Second) / frame
	longFrames     = int(longSpeech*Rate/time.Second) / frame
	maxFrames      = int(MaxUtterance*Rate/time.Second) / frame
)

// Cut is how an utterance ended.
type Cut int

const (
	// Silence ended it after 400 ms without speech: the speaker stopped.
	Silence Cut = iota + 1
	// Pause cut it short, at a shorter pause or at MaxUtterance, while
	// the speaker may still be in the middle of a sentence.
	Pause
)

// Event is what Push reports: an Utterance that ended, or Stopped.
type Event interface {
	event()
}

// Utterance is the audio of an utterance that ended, and how it ended.
type Utterance struct {
	Audio []int16
	Cut   Cut
}

// Stopped says that the silence after an utterance cut at a Pause has
// reached 400 ms without a new one starting.
type Stopped struct{}

func (Utterance) event() {}

func (Stopped) event() {}

type detector interface {
	Process(samples []float32) (float32, error)
}

// Utterances collects one speaker's audio into utterances. It is not safe
// for concurrent use.
type Utterances struct {
	detector     detector
	samples      [frame]float32
	pending      []int16
	preroll      []int16
	speech       []int16
	silentFrames int
	afterPause   bool
	sincePause   int
}

// New ends an utterance after 400 ms of silence (160 ms once it has run
// for 3 s), or after MaxUtterance of speech.
func New() (*Utterances, error) {
	silero, err := silerovad.NewDetector()
	if err != nil {
		return nil, fmt.Errorf("vad: load the Silero model: %w", err)
	}

	return detecting(silero), nil
}

func detecting(speech detector) *Utterances {
	return &Utterances{
		detector:     speech,
		samples:      [frame]float32{},
		pending:      make([]int16, 0, frame),
		preroll:      make([]int16, 0, prerollFrames*frame),
		speech:       nil,
		silentFrames: 0,
		afterPause:   false,
		sincePause:   0,
	}
}

// Active reports whether an utterance has started and not yet ended.
func (u *Utterances) Active() bool {
	return len(u.speech) > 0
}

// Samples is the length of the current utterance.
func (u *Utterances) Samples() int {
	return len(u.speech)
}

// Audio is a copy of the current utterance so far.
func (u *Utterances) Audio() []int16 {
	return append([]int16(nil), u.speech...)
}

// Push adds audio and returns every event within it, in order.
func (u *Utterances) Push(pcm []int16) ([]Event, error) {
	u.pending = append(u.pending, pcm...)

	var events []Event

	consumed := 0
	for ; len(u.pending)-consumed >= frame; consumed += frame {
		var err error

		events, err = u.frame(events, u.pending[consumed:consumed+frame])
		if err != nil {
			return events, err
		}
	}

	u.pending = append(u.pending[:0], u.pending[consumed:]...)

	return events, nil
}

// Flush ends the current utterance and returns it, or nil if there is none.
func (u *Utterances) Flush() []int16 {
	if !u.Active() {
		return nil
	}

	done := u.speech
	u.speech = nil
	u.preroll = u.preroll[:0]
	u.silentFrames = 0

	return done
}

func (u *Utterances) frame(events []Event, pcm []int16) ([]Event, error) {
	for i, sample := range pcm {
		u.samples[i] = float32(sample) / sampleScale
	}

	prob, err := u.detector.Process(u.samples[:])
	if err != nil {
		return events, fmt.Errorf("vad: detect speech: %w", err)
	}

	if !u.Active() {
		if u.idle(prob, pcm) {
			return append(events, Stopped{}), nil
		}

		return events, nil
	}

	u.speech = append(u.speech, pcm...)

	if prob < endProb {
		u.silentFrames++
	} else {
		u.silentFrames = 0
	}

	frames := len(u.speech) / frame

	end := endFrames
	if frames >= longFrames {
		end = shortEndFrames
	}

	if u.silentFrames < end && frames < maxFrames {
		return events, nil
	}

	cut := Pause
	if u.silentFrames >= endFrames {
		cut = Silence
	}

	silent := u.silentFrames
	ended := Utterance{Audio: u.Flush(), Cut: cut}
	u.afterPause = cut == Pause
	u.sincePause = silent

	return append(events, ended), nil
}

func (u *Utterances) idle(prob float32, pcm []int16) bool {
	stopped := u.stopped(prob)

	u.preroll = append(u.preroll, pcm...)
	if excess := len(u.preroll) - prerollFrames*frame; excess > 0 {
		u.preroll = append(u.preroll[:0], u.preroll[excess:]...)
	}

	if prob >= startProb {
		u.speech = append(make([]int16, 0, len(u.preroll)+frame), u.preroll...)
		u.silentFrames = 0
		u.afterPause = false
	}

	return stopped
}

func (u *Utterances) stopped(prob float32) bool {
	if !u.afterPause {
		return false
	}

	if prob >= endProb {
		u.afterPause = false

		return false
	}

	u.sincePause++
	if u.sincePause < endFrames {
		return false
	}

	u.afterPause = false

	return true
}
