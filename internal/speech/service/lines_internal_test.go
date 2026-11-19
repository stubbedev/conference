package service

import (
	"strings"
	"sync"
	"testing"

	"github.com/stubbe/conference/internal/speech/vad"
)

func newLines() *lines {
	return &lines{mu: sync.Mutex{}, held: "", seq: 0}
}

func TestFragmentCutAtAPauseIsHeldAndJoined(t *testing.T) {
	t.Parallel()

	assembled := newLines()

	held, done := assembled.utterance("Wir müssen die Lieferung verschieben.", vad.Pause)
	if done || held.text != "Wir müssen die Lieferung verschieben." {
		t.Fatalf("pause fragment gave %+v, done %v, want it held", held, done)
	}

	said, done := assembled.utterance("weil der Zulieferer Probleme hat.", vad.Silence)
	if want := "Wir müssen die Lieferung verschieben weil der Zulieferer Probleme hat."; !done || said.text != want || said.seq != 0 {
		t.Fatalf("got %+v, done %v, want %q as sentence 0", said, done, want)
	}

	if next := assembled.partial("Danke."); next.seq != 1 || next.text != "Danke." {
		t.Fatalf("next line %+v, want sentence 1 without the last one", next)
	}
}

func TestCapitalizedFragmentKeepsItsFullStop(t *testing.T) {
	t.Parallel()

	assembled := newLines()
	assembled.utterance("Hello there.", vad.Pause)

	said, _ := assembled.utterance("Thanks for joining.", vad.Silence)
	if want := "Hello there. Thanks for joining."; said.text != want {
		t.Fatalf("got %q, want %q", said.text, want)
	}
}

func TestPartialShowsWhatIsHeld(t *testing.T) {
	t.Parallel()

	assembled := newLines()
	assembled.utterance("We need to move the delivery.", vad.Pause)

	if got, want := assembled.partial(" because the supplier"), "We need to move the delivery because the supplier"; got.text != want {
		t.Fatalf("partial %q, want %q", got.text, want)
	}
}

func TestStoppedFinishesWhatIsHeld(t *testing.T) {
	t.Parallel()

	assembled := newLines()

	if empty := assembled.stopped(); empty.text != "" || empty.seq != 0 {
		t.Fatalf("stopped with nothing held gave %+v", empty)
	}

	assembled.utterance("Okay.", vad.Pause)

	if said := assembled.stopped(); said.text != "Okay." || said.seq != 0 {
		t.Fatalf("stopped gave %+v, want the held fragment as sentence 0", said)
	}

	if again := assembled.stopped(); again.text != "" || again.seq != 1 {
		t.Fatalf("second stop gave %+v, want nothing", again)
	}
}

func TestLongHeldLineIsFinished(t *testing.T) {
	t.Parallel()

	assembled := newLines()
	fragment := strings.Repeat("ä", maxHeldChars/2) + ","
	assembled.utterance(fragment, vad.Pause)

	said, done := assembled.utterance(fragment, vad.Pause)
	if !done || said.text != fragment+" "+fragment {
		t.Fatalf("got %+v, done %v, want the long line finished", said, done)
	}
}
