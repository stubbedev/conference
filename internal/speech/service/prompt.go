package service

import (
	"fmt"
	"maps"
	"strings"
)

const (
	contextSentences = 3
	promptSource     = "{source}"
	promptTarget     = "{target}"
	promptTask       = "You translate spoken " + promptSource + " from a business video call into natural spoken " +
		promptTarget + ". Reply with the translation only."
	promptEarlier = " Earlier sentences, for context only: "
)

// Prompt is the instruction a language model translates with, in the
// pieces a browser assembles exactly as render does.
type Prompt struct {
	Task      string            `json:"task"`
	Address   map[string]string `json:"address"`
	Glossary  string            `json:"glossary,omitempty"`
	Earlier   string            `json:"earlier"`
	Sentences int               `json:"sentences"`
}

func newPrompt(glossary string, available languages) Prompt {
	address := make(map[string]string)

	for _, lang := range available.all() {
		if lang.Address != "" {
			address[lang.Code] = fmt.Sprintf(" %s.", lang.Address)
		}
	}

	rendered := ""
	if glossary != "" {
		rendered = fmt.Sprintf(" Use these term translations: %s.", glossary)
	}

	return Prompt{
		Task:      promptTask,
		Address:   address,
		Glossary:  rendered,
		Earlier:   promptEarlier,
		Sentences: contextSentences,
	}
}

func (p Prompt) render(source, target language, earlier []string) string {
	var prompt strings.Builder

	prompt.WriteString(strings.NewReplacer(promptSource, source.Name, promptTarget, target.Name).Replace(p.Task))
	prompt.WriteString(p.Address[target.Code])
	prompt.WriteString(p.Glossary)

	if len(earlier) > 0 {
		prompt.WriteString(p.Earlier)
		prompt.WriteString(strings.Join(earlier[max(0, len(earlier)-p.Sentences):], " "))
	}

	return prompt.String()
}

func (p Prompt) clone() Prompt {
	p.Address = maps.Clone(p.Address)

	return p
}
