package service

import (
	"strings"

	"github.com/stubbe/conference/internal/speech/wire"
)

// Status is what the web app needs to know about live translation:
// whether it can run, what is missing when it cannot, which machine runs
// it, the languages, and whether any engine sends audio or text off this
// network.
type Status struct {
	Available bool   `json:"available"`
	Reason    string `json:"reason,omitempty"`
	// Mode is server when this server runs the engines and browser when
	// every member's browser does.
	Mode string `json:"mode"`
	// Fake marks the stand-in engines: numbered transcripts, "[lang] …"
	// translations and a tone for a voice, which the browser has too.
	Fake bool `json:"fake,omitempty"`
	// Models is what the browsers load, absent when this server runs the
	// engines.
	Models    *Models         `json:"models,omitempty"`
	Languages []wire.Language `json:"languages"`
	External  bool            `json:"external"`
}

// Status reports whether live translation can run with these settings.
func (s Settings) Status() Status {
	all := s.languages.all()

	langs := make([]wire.Language, len(all))
	for i, lang := range all {
		langs[i] = wire.Language{Code: lang.Code, Name: lang.Name}
	}

	status := Status{
		Available: s.ready(),
		Reason:    s.notReadyReason(),
		Mode:      string(s.runtime),
		Fake:      s.standIn(),
		Models:    nil,
		Languages: langs,
		External:  s.external(),
	}

	if s.runtime == runInBrowser {
		loaded := s.models
		status.Models = &loaded
	}

	return status
}

// notReadyReason names what still has to arrive before live translation
// can run, such as the variable to set for each engine that has none, or
// the models the browsers load. It is read by whoever runs the server, in
// /api/config: the app shows nothing about translation until every engine
// is set up, so this never reaches the people in a call.
func (s Settings) notReadyReason() string {
	if s.runtime == runInBrowser {
		if s.models.problem == "" {
			return ""
		}

		return "Live translation needs " + s.models.problem + "."
	}

	var missing []string

	for _, entry := range s.engines() {
		if entry.engine.ready() {
			continue
		}

		missing = append(missing, entry.engine.problem)
	}

	if len(missing) == 0 {
		return ""
	}

	return "Live translation needs " + list(missing) + "."
}

// list joins names the way a sentence does: one on its own, two with and
// between them, more with commas and a final and.
func list(items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	case 2:
		return items[0] + " and " + items[1]
	default:
		return strings.Join(items[:len(items)-1], ", ") + " and " + items[len(items)-1]
	}
}
