package service

import (
	"testing"
)

const testGlossary = "Kontainer = Kontainer"

func TestPromptNamesBothLanguagesTheAddressAndTheGlossary(t *testing.T) {
	t.Parallel()

	available := builtinLanguages(t)
	german, _ := available.get("de")
	english, _ := available.get("en")

	prompt := newPrompt(testGlossary, available)
	got := prompt.render(english, german, []string{"one.", "two.", "three.", "four."})
	want := "You translate spoken English from a business video call into natural spoken German. " +
		"Reply with the translation only. " + german.Address + "." +
		" Use these term translations: Kontainer = Kontainer." +
		" Earlier sentences, for context only: two. three. four."

	if got != want {
		t.Fatalf("prompt\n%q\nwant\n%q", got, want)
	}
}

func TestPromptWithoutGlossaryOrEarlierSentences(t *testing.T) {
	t.Parallel()

	available := builtinLanguages(t)
	german, _ := available.get("de")
	english, _ := available.get("en")

	got := newPrompt("", available).render(german, english, nil)
	want := "You translate spoken German from a business video call into natural spoken English. Reply with the translation only."

	if got != want {
		t.Fatalf("prompt %q, want %q", got, want)
	}
}

func builtinLanguages(t *testing.T) languages {
	t.Helper()

	langs, err := parseLanguages(defaultLanguages)
	if err != nil {
		t.Fatalf("built-in languages: %v", err)
	}

	return langs
}
