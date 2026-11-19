package vad

import (
	"slices"
	"testing"
	"time"
)

const (
	speaking = 0.9
	quiet    = 0.1
)

type script struct {
	probs []float32
}

func (s *script) Process([]float32) (float32, error) {
	prob := s.probs[0]
	s.probs = s.probs[1:]

	return prob, nil
}

func frames(d time.Duration) int {
	return int(d*Rate/time.Second) / frame
}

func repeat(prob float32, n int) []float32 {
	probs := make([]float32, n)
	for i := range probs {
		probs[i] = prob
	}

	return probs
}

func run(t *testing.T, probs ...[]float32) []Event {
	t.Helper()

	var all []float32
	for _, part := range probs {
		all = append(all, part...)
	}

	cutter := detecting(&script{probs: all})

	events, err := cutter.Push(make([]int16, len(all)*frame))
	if err != nil {
		t.Fatalf("push: %v", err)
	}

	return events
}

func cuts(events []Event) []any {
	kinds := make([]any, 0, len(events))

	for _, event := range events {
		switch got := event.(type) {
		case Utterance:
			kinds = append(kinds, got.Cut)
		case Stopped:
			kinds = append(kinds, got)
		}
	}

	return kinds
}

func TestShortSpeechEndsAtSilenceWithoutAStop(t *testing.T) {
	t.Parallel()

	got := cuts(run(t, repeat(speaking, frames(time.Second)), repeat(quiet, frames(2*time.Second))))
	if want := []any{Silence}; !slices.Equal(got, want) {
		t.Fatalf("events %v, want %v", got, want)
	}
}

func TestLongSpeechIsCutAtAPauseAndStopsWhenTheSilenceGrows(t *testing.T) {
	t.Parallel()

	got := cuts(run(t, repeat(speaking, frames(4*time.Second)), repeat(quiet, frames(time.Second))))
	if want := []any{Pause, Stopped{}}; !slices.Equal(got, want) {
		t.Fatalf("events %v, want %v", got, want)
	}
}

func TestSpeakingOnAfterAPauseIsNoStop(t *testing.T) {
	t.Parallel()

	got := cuts(run(t,
		repeat(speaking, frames(4*time.Second)),
		repeat(quiet, frames(250*time.Millisecond)),
		repeat(speaking, frames(time.Second)),
		repeat(quiet, frames(time.Second)),
	))
	if want := []any{Pause, Silence}; !slices.Equal(got, want) {
		t.Fatalf("events %v, want %v", got, want)
	}
}

func TestTheLengthLimitIsAPause(t *testing.T) {
	t.Parallel()

	got := cuts(run(t, repeat(speaking, frames(MaxUtterance)+1)))
	if want := []any{Pause}; !slices.Equal(got, want) {
		t.Fatalf("events %v, want %v", got, want)
	}
}
