package vad_test

import (
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/stubbe/conference/internal/speech/vad"
	"github.com/stubbe/conference/internal/speech/wav"
)

const chunk = 320

func fixture(t *testing.T, name string) []int16 {
	t.Helper()

	data, err := fs.ReadFile(os.DirFS(filepath.Join("..", "..", "..", "fixtures")), name)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	pcm, rate, err := wav.Decode(data)
	if err != nil {
		t.Fatalf("decode %s: %v", name, err)
	}

	if rate != vad.Rate {
		t.Fatalf("%s is %d Hz, want %d", name, rate, vad.Rate)
	}

	return pcm
}

func utterances(t *testing.T, pcm []int16) [][]int16 {
	t.Helper()

	cutter, err := vad.New()
	if err != nil {
		t.Fatalf("new: %v", err)
	}

	var found [][]int16

	for start := 0; start < len(pcm); start += chunk {
		done, err := cutter.Push(pcm[start:min(start+chunk, len(pcm))])
		if err != nil {
			t.Fatalf("push: %v", err)
		}

		found = append(found, done...)
	}

	if rest := cutter.Flush(); rest != nil {
		found = append(found, rest)
	}

	return found
}

func TestSpeechIsCutIntoUtterances(t *testing.T) {
	t.Parallel()

	for _, name := range []string{"english.wav", "german.wav", "swedish.wav"} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			pcm := append(fixture(t, name), make([]int16, vad.Rate)...)
			found := utterances(t, pcm)

			if len(found) == 0 {
				t.Fatal("no utterance in a recording of speech")
			}

			total := 0

			for _, utterance := range found {
				if len(utterance) > int(vad.MaxUtterance.Seconds())*vad.Rate {
					t.Fatalf("utterance of %d samples is longer than the maximum segment", len(utterance))
				}

				total += len(utterance)
			}

			if total < len(pcm)/2 {
				t.Fatalf("utterances hold %d of %d samples, want most of the recording", total, len(pcm))
			}
		})
	}
}

func TestSilenceHasNoUtterance(t *testing.T) {
	t.Parallel()

	if found := utterances(t, make([]int16, 5*vad.Rate)); len(found) != 0 {
		t.Fatalf("%d utterances in silence, want none", len(found))
	}
}
