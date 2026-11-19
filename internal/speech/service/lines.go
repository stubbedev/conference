package service

import (
	"regexp"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/stubbe/conference/internal/speech/vad"
)

const maxHeldChars = 160

var (
	closedFragment = regexp.MustCompile(`[.…]+$`)
	carriesOn      = regexp.MustCompile(`^\p{Ll}`)
)

type line struct {
	seq  int64
	text string
}

type lines struct {
	mu   sync.Mutex
	held string
	seq  int64
}

func joined(held, text string) string {
	if held == "" || text == "" {
		return held + text
	}

	if carriesOn.MatchString(text) {
		held = closedFragment.ReplaceAllString(held, "")
	}

	return held + " " + text
}

func (l *lines) partial(text string) line {
	l.mu.Lock()
	defer l.mu.Unlock()

	return line{seq: l.seq, text: joined(l.held, strings.TrimSpace(text))}
}

func (l *lines) utterance(text string, cut vad.Cut) (line, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()

	text = joined(l.held, strings.TrimSpace(text))
	if cut == vad.Pause && utf8.RuneCountInString(text) < maxHeldChars {
		l.held = text

		return line{seq: l.seq, text: text}, false
	}

	return l.finish(text), true
}

func (l *lines) stopped() line {
	l.mu.Lock()
	defer l.mu.Unlock()

	return l.finish(l.held)
}

func (l *lines) finish(text string) line {
	done := line{seq: l.seq, text: text}
	l.held = ""

	if text != "" {
		l.seq++
	}

	return done
}
