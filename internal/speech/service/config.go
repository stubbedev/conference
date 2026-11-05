// Package service is the speech service behind live translation: each
// speaking member's browser streams its microphone here, and gets back
// subtitles and a translated voice for every listener language.
package service

import (
	"errors"
	"fmt"
	"log"
	"net"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type provider string

const (
	openAICompatible provider = "openai-compatible"
	ollama           provider = "ollama"
	fake             provider = "fake"
)

type purpose string

const (
	transcription purpose = "transcription"
	translation   purpose = "translation"
	voice         purpose = "voice"
)

const (
	openAIURL         = "https://api.openai.com/v1"
	defaultOllamaURL  = "http://localhost:11434"
	defaultHost       = "0.0.0.0"
	defaultPort       = "8090"
	defaultVoiceRate  = 24000
	defaultSilence    = 400 * time.Millisecond
	defaultMaxSegment = 12 * time.Second
	defaultInterim    = 600 * time.Millisecond

	envSecret            = "SPEECH_SECRET"
	envEngines           = "ENGINES"
	envLanguagesFile     = "LANGUAGES_FILE"
	envOpenAIURL         = "OPENAI_URL"
	envOpenAIKey         = "OPENAI_API_KEY"
	envTranslateProvider = "TRANSLATE_PROVIDER"
	envVoiceName         = "VOICE_NAME"
	prefixTranscribe     = "TRANSCRIBE"
	prefixTranslate      = "TRANSLATE"
	prefixVoice          = "VOICE"
)

type engine struct {
	provider provider
	url      string
	apiKey   string
	model    string
	problem  string
	external bool
}

func (e engine) ready() bool {
	return e.problem == ""
}

type namedEngine struct {
	purpose purpose
	engine  engine
}

// Settings configure the speech service; FromEnv reads them.
type Settings struct {
	Addr          string
	secret        []byte
	transcription engine
	translation   engine
	voice         engine
	voiceName     string
	voiceRate     int
	silence       time.Duration
	maxSegment    time.Duration
	interim       time.Duration
	glossary      string
	languages     languages
}

// LogEngines says which engines are not set up yet and which send audio
// or text off this network.
func (s Settings) LogEngines() {
	for _, entry := range s.engines() {
		switch {
		case !entry.engine.ready():
			log.Printf("%s is not set up (%s): live translation is unavailable", entry.purpose, entry.engine.problem)
		case entry.engine.external:
			log.Printf("%s goes to an external service (%s at %s): audio or text leaves this network",
				entry.purpose, entry.engine.provider, entry.engine.url)
		default:
			log.Printf("%s: %s %s", entry.purpose, entry.engine.provider, entry.engine.model)
		}
	}
}

func (s Settings) engines() []namedEngine {
	return []namedEngine{
		{purpose: transcription, engine: s.transcription},
		{purpose: translation, engine: s.translation},
		{purpose: voice, engine: s.voice},
	}
}

func (s Settings) ready() bool {
	return s.transcription.ready() && s.translation.ready() && s.voice.ready()
}

func (s Settings) external() bool {
	return s.transcription.external || s.translation.external || s.voice.external
}

var (
	errNoSecret       = errors.New(envSecret + " must be set")
	errEnginesMode    = errors.New(envEngines + " must be real or fake")
	errExternalValue  = errors.New("must be true or false")
	errTranslateValue = errors.New(envTranslateProvider + " must be ollama or openai-compatible")
	errNegative       = errors.New("must not be negative")
)

// FromEnv reads the settings from the environment that getenv looks up.
func FromEnv(getenv func(string) string) (Settings, error) {
	env := environment(getenv)

	secret := env(envSecret)
	if secret == "" {
		return Settings{}, errNoSecret
	}

	settings, err := env.tuning()
	if err != nil {
		return Settings{}, err
	}

	settings.secret = []byte(secret)
	settings.Addr = net.JoinHostPort(env.or("HOST", defaultHost), env.or("PORT", defaultPort))
	settings.voiceName = env(envVoiceName)
	settings.glossary = env("GLOSSARY")

	switch env.or(envEngines, "real") {
	case "fake":
		stand := engine{provider: fake, url: "", apiKey: "", model: "", problem: "", external: false}
		settings.transcription, settings.translation, settings.voice = stand, stand, stand

		return settings, nil
	case "real":
		return env.realEngines(settings)
	default:
		return Settings{}, errEnginesMode
	}
}

func (env environment) tuning() (Settings, error) {
	langs, err := env.languages()
	if err != nil {
		return Settings{}, err
	}

	voiceRate, err := env.int("VOICE_RATE", defaultVoiceRate)
	if err != nil {
		return Settings{}, err
	}

	silence, err := env.duration("SILENCE_MS", time.Millisecond, defaultSilence)
	if err != nil {
		return Settings{}, err
	}

	maxSegment, err := env.duration("MAX_SEGMENT_S", time.Second, defaultMaxSegment)
	if err != nil {
		return Settings{}, err
	}

	interim, err := env.duration("INTERIM_MS", time.Millisecond, defaultInterim)
	if err != nil {
		return Settings{}, err
	}

	return Settings{
		Addr:          "",
		secret:        nil,
		transcription: engine{provider: "", url: "", apiKey: "", model: "", problem: "", external: false},
		translation:   engine{provider: "", url: "", apiKey: "", model: "", problem: "", external: false},
		voice:         engine{provider: "", url: "", apiKey: "", model: "", problem: "", external: false},
		voiceName:     "",
		voiceRate:     voiceRate,
		silence:       silence,
		maxSegment:    maxSegment,
		interim:       interim,
		glossary:      "",
		languages:     langs,
	}, nil
}

func (env environment) realEngines(settings Settings) (Settings, error) {
	var err error

	settings.transcription, err = env.openAICompatible(prefixTranscribe, transcription)
	if err != nil {
		return Settings{}, err
	}

	settings.translation, err = env.translationEngine()
	if err != nil {
		return Settings{}, err
	}

	settings.voice, err = env.openAICompatible(prefixVoice, voice)
	if err != nil {
		return Settings{}, err
	}

	if missing := settings.missingVoices(); settings.voice.ready() && len(missing) > 0 {
		settings.voice.problem = "set voices in the languages file (or " + envVoiceName + ") for " + strings.Join(missing, ", ")
	}

	return settings, nil
}

func (s Settings) missingVoices() []string {
	if s.voiceName != "" {
		return nil
	}

	var missing []string

	for _, lang := range s.languages.all() {
		if len(lang.Voices) == 0 {
			missing = append(missing, lang.Code)
		}
	}

	return missing
}

type environment func(string) string

func (env environment) or(name, fallback string) string {
	if value := env(name); value != "" {
		return value
	}

	return fallback
}

func (env environment) int(name string, fallback int) (int, error) {
	value := env(name)
	if value == "" {
		return fallback, nil
	}

	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("%s=%q: %w", name, value, err)
	}

	if parsed < 0 {
		return 0, fmt.Errorf("%s=%q %w", name, value, errNegative)
	}

	return parsed, nil
}

func (env environment) duration(name string, unit, fallback time.Duration) (time.Duration, error) {
	value := env(name)
	if value == "" {
		return fallback, nil
	}

	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return 0, fmt.Errorf("%s=%q: %w", name, value, err)
	}

	if parsed < 0 {
		return 0, fmt.Errorf("%s=%q %w", name, value, errNegative)
	}

	return time.Duration(parsed * float64(unit)), nil
}

func (env environment) languages() (languages, error) {
	path := env(envLanguagesFile)
	if path == "" {
		return parseLanguages(defaultLanguages)
	}

	data, err := os.ReadFile(path) //nolint:gosec // The operator names this file.
	if err != nil {
		return languages{}, fmt.Errorf("read %s: %w", envLanguagesFile, err)
	}

	langs, err := parseLanguages(data)
	if err != nil {
		return languages{}, fmt.Errorf("%s %s: %w", envLanguagesFile, path, err)
	}

	return langs, nil
}

func (env environment) openAICompatible(prefix string, use purpose) (engine, error) {
	address := strings.TrimRight(env.or(prefix+"_URL", env.or(envOpenAIURL, openAIURL)), "/")

	external, err := env.external(prefix, address)
	if err != nil {
		return engine{}, err
	}

	model := env(prefix + "_MODEL")

	problem := ""
	if model == "" {
		problem = fmt.Sprintf("set %s_MODEL to the %s model to use", prefix, use)
	}

	return engine{
		provider: openAICompatible,
		url:      address,
		apiKey:   env.or(prefix+"_API_KEY", env(envOpenAIKey)),
		model:    model,
		problem:  problem,
		external: external,
	}, nil
}

func (env environment) translationEngine() (engine, error) {
	chosen := provider(env.or(envTranslateProvider, string(ollama)))
	if chosen == openAICompatible {
		return env.openAICompatible(prefixTranslate, translation)
	}

	if chosen != ollama {
		return engine{}, fmt.Errorf("%w, not %q", errTranslateValue, chosen)
	}

	address := strings.TrimRight(env.or(prefixTranslate+"_URL", defaultOllamaURL), "/")

	external, err := env.external(prefixTranslate, address)
	if err != nil {
		return engine{}, err
	}

	model := env(prefixTranslate + "_MODEL")

	problem := ""
	if model == "" {
		problem = "set " + prefixTranslate + "_MODEL to the Ollama model to translate with"
	}

	return engine{provider: ollama, url: address, apiKey: "", model: model, problem: problem, external: external}, nil
}

func (env environment) external(prefix, address string) (bool, error) {
	name := prefix + "_EXTERNAL"

	switch value := strings.ToLower(env(name)); value {
	case "":
		return isExternal(address), nil
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, fmt.Errorf("%s=%q %w", name, value, errExternalValue)
	}
}

func isExternal(address string) bool {
	parsed, err := url.Parse(address)
	if err != nil {
		return true
	}

	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return false
	}

	ip, err := netip.ParseAddr(host)
	if err == nil {
		return !ip.IsLoopback() && !ip.IsPrivate() && !ip.IsLinkLocalUnicast()
	}

	return host != "localhost" && strings.Contains(host, ".") &&
		!strings.HasSuffix(host, ".local") && !strings.HasSuffix(host, ".internal") && !strings.HasSuffix(host, ".lan")
}
