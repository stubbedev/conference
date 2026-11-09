package service

import (
	"strings"

	"github.com/stubbe/conference/internal/speech/wire"
)

// Status is what the web app needs to know about live translation:
// whether it can run, what is missing when it cannot, the languages, and
// whether any engine sends audio or text off this network.
type Status struct {
	Available bool            `json:"available"`
	Reason    string          `json:"reason,omitempty"`
	Languages []wire.Language `json:"languages"`
	External  bool            `json:"external"`
	// OwnVoice says whether a speaker can be heard in their own voice,
	// cloned or converted; the app only offers it then.
	OwnVoice bool `json:"ownVoice"`
}

// Status reports whether live translation can run with these settings.
func (s Settings) Status() Status {
	all := s.languages.all()

	langs := make([]wire.Language, len(all))
	for i, lang := range all {
		langs[i] = wire.Language{Code: lang.Code, Name: lang.Name}
	}

	return Status{
		Available: s.ready(),
		Reason:    s.notReadyReason(),
		Languages: langs,
		External:  s.external(),
		OwnVoice:  s.ownVoice(),
	}
}

// notReadyReason names what the engines still need, such as the model
// to set for each engine that has none.
func (s Settings) notReadyReason() string {
	var purposes, problems []string

	for _, entry := range s.engines() {
		if entry.engine.ready() {
			continue
		}

		purposes = append(purposes, string(entry.purpose))
		problems = append(problems, entry.engine.problem)
	}

	if len(purposes) == 0 {
		return ""
	}

	return "Live translation needs a " + strings.Join(purposes, " and ") + " model to be set up: " +
		strings.Join(problems, "; ") + "."
}
