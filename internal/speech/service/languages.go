package service

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
)

type voiceChoice string

const (
	voiceFemale voiceChoice = "female"
	voiceMale   voiceChoice = "male"
	// voiceOwn is the speaker's own voice, cloned from a sample they
	// recorded (see session.ownVoice); without one, or without a cloning
	// voice engine, they are heard in the default voice.
	voiceOwn     voiceChoice = "own"
	defaultVoice             = voiceFemale
)

func parseVoiceChoice(s string) voiceChoice {
	switch choice := voiceChoice(s); choice {
	case voiceMale, voiceOwn:
		return choice
	case voiceFemale:
		return voiceFemale
	default:
		return defaultVoice
	}
}

// stock is the voice from the languages file that a choice speaks in.
func (c voiceChoice) stock() voiceChoice {
	if c == voiceOwn {
		return defaultVoice
	}

	return c
}

type language struct {
	Code    string                 `json:"code"`
	Name    string                 `json:"name"`
	Whisper string                 `json:"whisper"`
	Address string                 `json:"address,omitempty"`
	Voices  map[voiceChoice]string `json:"voices,omitempty"`
}

type languages struct {
	ordered []language
	byCode  map[string]language
}

//go:embed languages.json
var defaultLanguages []byte

var (
	errNoLanguages     = errors.New("no languages")
	errLanguageFields  = errors.New("a language needs code, name and whisper")
	errDuplicateLang   = errors.New("duplicate language")
	errUnknownVoiceKey = errors.New("unknown voice choice")
)

func parseLanguages(data []byte) (languages, error) {
	var list []language

	err := json.Unmarshal(data, &list)
	if err != nil {
		return languages{}, fmt.Errorf("parse languages: %w", err)
	}

	if len(list) == 0 {
		return languages{}, errNoLanguages
	}

	byCode := make(map[string]language, len(list))

	for _, lang := range list {
		err = lang.validate()
		if err != nil {
			return languages{}, err
		}

		if _, seen := byCode[lang.Code]; seen {
			return languages{}, fmt.Errorf("%w: %s", errDuplicateLang, lang.Code)
		}

		byCode[lang.Code] = lang
	}

	return languages{ordered: list, byCode: byCode}, nil
}

func (l language) validate() error {
	if l.Code == "" || l.Name == "" || l.Whisper == "" {
		return fmt.Errorf("%w: %+v", errLanguageFields, l)
	}

	for choice := range l.Voices {
		if choice != voiceFemale && choice != voiceMale {
			return fmt.Errorf("%w %q in %s", errUnknownVoiceKey, choice, l.Code)
		}
	}

	return nil
}

func (l languages) all() []language {
	return l.ordered
}

func (l languages) get(code string) (language, bool) {
	lang, ok := l.byCode[code]

	return lang, ok
}
