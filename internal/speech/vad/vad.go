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

// Utterances collects one speaker's audio into utterances. It is not safe
// for concurrent use.
type Utterances struct {
	detector     *silerovad.Detector
	samples      [frame]float32
	pending      []int16
	preroll      []int16
	speech       []int16
	silentFrames int
}

// New ends an utterance after 400 ms of silence (160 ms once it has run
// for 3 s), or after MaxUtterance of speech.
func New() (*Utterances, error) {
	detector, err := silerovad.NewDetector()
	if err != nil {
		return nil, fmt.Errorf("vad: load the Silero model: %w", err)
	}

	return &Utterances{
		detector:     detector,
		samples:      [frame]float32{},
		pending:      make([]int16, 0, frame),
		preroll:      make([]int16, 0, prerollFrames*frame),
		speech:       nil,
		silentFrames: 0,
	}, nil
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

// Push adds audio and returns every utterance that ended within it.
func (u *Utterances) Push(pcm []int16) ([][]int16, error) {
	u.pending = append(u.pending, pcm...)

	var finished [][]int16

	consumed := 0
	for ; len(u.pending)-consumed >= frame; consumed += frame {
		done, err := u.frame(u.pending[consumed : consumed+frame])
		if err != nil {
			return finished, err
		}

		if done != nil {
			finished = append(finished, done)
		}
	}

	u.pending = append(u.pending[:0], u.pending[consumed:]...)

	return finished, nil
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

func (u *Utterances) frame(pcm []int16) ([]int16, error) {
	for i, sample := range pcm {
		u.samples[i] = float32(sample) / sampleScale
	}

	prob, err := u.detector.Process(u.samples[:])
	if err != nil {
		return nil, fmt.Errorf("vad: detect speech: %w", err)
	}

	if !u.Active() {
		u.preroll = append(u.preroll, pcm...)
		if excess := len(u.preroll) - prerollFrames*frame; excess > 0 {
			u.preroll = append(u.preroll[:0], u.preroll[excess:]...)
		}

		if prob >= startProb {
			u.speech = append(make([]int16, 0, len(u.preroll)+frame), u.preroll...)
			u.silentFrames = 0
		}

		return nil, nil
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

	if u.silentFrames >= end || frames >= maxFrames {
		return u.Flush(), nil
	}

	return nil, nil
}
