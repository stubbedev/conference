package service

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	// A translation shorter than this is spoken whole: its first sound
	// would come barely sooner in pieces.
	piecesFrom = 80
	// No piece is shorter than this, so a voice is never asked for a word
	// or two that it would speak without its sentence's intonation.
	minPiece = 30
)

// speechPieces splits a long translation where a speaker would pause, at
// a sentence or clause boundary (punctuation followed by a space), so its
// first piece can be voiced and heard while the rest is still being made.
// The pieces, joined with spaces, are the translation.
func speechPieces(text string) []string {
	text = strings.TrimSpace(text)
	if utf8.RuneCountInString(text) < piecesFrom {
		return []string{text}
	}

	var pieces []string

	start := 0

	for _, end := range pauses(text) {
		if utf8.RuneCountInString(text[start:end]) >= minPiece {
			pieces = append(pieces, strings.TrimSpace(text[start:end]))
			start = end
		}
	}

	rest := strings.TrimSpace(text[start:])

	switch {
	case rest == "":
	case len(pieces) > 0 && utf8.RuneCountInString(rest) < minPiece:
		pieces[len(pieces)-1] += " " + rest
	default:
		pieces = append(pieces, rest)
	}

	return pieces
}

// pauses are the byte offsets just after every piece of punctuation that
// a space follows, where a speaker would pause.
func pauses(text string) []int {
	var after []int

	for i, r := range text {
		next := i + utf8.RuneLen(r)
		if next >= len(text) || !strings.ContainsRune(".!?;:,…—", r) {
			continue
		}

		following, _ := utf8.DecodeRuneInString(text[next:])
		if unicode.IsSpace(following) {
			after = append(after, next)
		}
	}

	return after
}
