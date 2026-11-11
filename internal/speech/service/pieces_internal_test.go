package service

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stubbe/conference/internal/speech/vad"
)

const longGerman = "Wir müssen die Lieferung um zwei Wochen verschieben, weil der Zulieferer Probleme hat. " +
	"Können Sie mir die Produktdaten bis Freitag schicken – am liebsten als Excel-Datei?"

func TestSpeechPieces(t *testing.T) {
	t.Parallel()

	short := "Guten Morgen, schön, dass Sie da sind."
	if got := speechPieces(short); !slices.Equal(got, []string{short}) {
		t.Errorf("a short sentence was split: %q", got)
	}

	got := speechPieces(longGerman)
	want := []string{
		"Wir müssen die Lieferung um zwei Wochen verschieben,",
		"weil der Zulieferer Probleme hat.",
		"Können Sie mir die Produktdaten bis Freitag schicken – am liebsten als Excel-Datei?",
	}

	if !slices.Equal(got, want) {
		t.Errorf("pieces %q, want %q", got, want)
	}

	if strings.Join(got, " ") != longGerman {
		t.Error("the pieces, joined, are not the translation")
	}
}

func TestSpeechPiecesKeepNumbersAndShortClauses(t *testing.T) {
	t.Parallel()

	text := "Der Umsatz stieg um 3,5 Prozent auf 1.200 Einheiten, ja, und das ist für dieses Quartal wirklich ein sehr gutes Ergebnis."

	for _, piece := range speechPieces(text) {
		if utf8.RuneCountInString(piece) < minPiece {
			t.Errorf("piece %q is shorter than %d characters", piece, minPiece)
		}

		if strings.HasSuffix(piece, "3,") || strings.HasSuffix(piece, "1.") {
			t.Errorf("a number was split: %q", piece)
		}
	}

	if strings.Join(speechPieces(text), " ") != text {
		t.Error("the pieces, joined, are not the translation")
	}
}

// sentPieces is the text of every voice frame sent, in order: the stand-in
// voice below speaks a piece as its own bytes.
func sentPieces(out *outbox) []string {
	var texts []string

	for _, message := range out.snapshot() {
		if frame, ok := message.(voiceFrame); ok {
			texts = append(texts, string(frame.pcm))
		}
	}

	return texts
}

// slowFirst is a stand-in voice that takes longer the earlier a piece
// comes, so the pieces finish in reverse.
type slowFirst struct {
	stubEngines
}

func (slowFirst) speak(_ context.Context, text string, _ language, _ voiceChoice, _ *reference) (speech, error) {
	time.Sleep(time.Duration(utf8.RuneCountInString(longGerman)-strings.Index(longGerman, text)) * time.Millisecond)

	return speech{pcm: []byte(text), rate: vad.Rate, converting: 0}, nil
}

func TestALongTranslationIsVoicedInPiecesSentInOrder(t *testing.T) {
	t.Parallel()

	engines := slowFirst{
		transcribeFn: echoTranscripts,
		translateFn:  func(string, language) (string, error) { return longGerman, nil },
	}
	opened, out := newOwnVoiceSession(t, "", engines)

	started := time.Now()

	opened.translate(t.Context(), opened.speaker, sentence(t, opened, voiceFemale, 1), mustLanguage(t, opened.settings, "en"), "hallo", nil)

	if got := sentPieces(out); !slices.Equal(got, speechPieces(longGerman)) {
		t.Fatalf("sent %q, want the pieces in order", got)
	}

	// Asked for at once: the whole takes about as long as the slowest piece.
	if took := time.Since(started); took > time.Duration(utf8.RuneCountInString(longGerman))*time.Millisecond*3/2 {
		t.Errorf("voicing the pieces took %s, as if one after another", took)
	}
}
