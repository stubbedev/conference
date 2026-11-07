// Package service is the speech service behind live translation: each
// speaking member's browser streams its microphone here, and gets back
// subtitles and a translated voice for every listener language.
package service

import (
	"errors"
	"fmt"
	"log"
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

type responseFormat string

const (
	formatJSON    responseFormat = "json"
	formatVerbose responseFormat = "verbose_json"
)

// runtime is the machine that runs the speech engines: this server, or
// every member's own browser.
type runtime string

const (
	runOnServer  runtime = "server"
	runInBrowser runtime = "browser"
)

const (
	openAIURL        = "https://api.openai.com/v1"
	defaultOllamaURL = "http://localhost:11434"
	defaultInterim   = 600 * time.Millisecond

	envRuntime           = "SPEECH_RUNTIME"
	envEngines           = "SPEECH_ENGINES"
	envModelDir          = "SPEECH_MODEL_DIR"
	envModelsFile        = "SPEECH_MODELS_FILE"
	envLanguagesFile     = "LANGUAGES_FILE"
	envOpenAIKey         = "OPENAI_API_KEY"
	envInternalDomains   = "INTERNAL_DOMAINS"
	envTranslateProvider = "TRANSLATE_PROVIDER"
	envTranscribeFormat  = "TRANSCRIBE_RESPONSE_FORMAT"
	envVoiceName         = "VOICE_NAME"
	envInterim           = "INTERIM_MS"
	prefixTranscribe     = "TRANSCRIBE"
	prefixTranslate      = "TRANSLATE"
	prefixVoice          = "VOICE"
)

type engine struct {
	provider provider
	endpoint *url.URL
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
	runtime          runtime
	transcription    engine
	transcribeFormat responseFormat
	translation      engine
	voice            engine
	voiceName        string
	interim          time.Duration
	glossary         string
	languages        languages
	models           Models
	modelDir         string
}

// LogEngines says which runtime runs the engines, which engines are not
// set up yet, which send audio or text off this network, and whether
// interim subtitles are on.
func (s Settings) LogEngines() {
	if s.runtime == runInBrowser {
		s.logBrowserRuntime()

		return
	}

	for _, entry := range s.engines() {
		switch {
		case !entry.engine.ready():
			log.Printf("%s is not set up (%s): live translation is unavailable", entry.purpose, entry.engine.problem)
		case entry.engine.external:
			log.Printf("%s goes to an external service (%s at %s): audio or text leaves this network",
				entry.purpose, entry.engine.provider, entry.engine.endpoint.Redacted())
		default:
			log.Printf("%s: %s %s", entry.purpose, entry.engine.provider, entry.engine.model)
		}
	}

	if s.interim == 0 {
		log.Printf("interim subtitles are off (%s=0, the default for an external transcription engine)", envInterim)
	}
}

// ModelDir is the directory the browsers load their models from, empty
// when they load none from this server.
func (s Settings) ModelDir() string {
	if s.models.Base == "" {
		return ""
	}

	return s.modelDir
}

func (s Settings) engines() []namedEngine {
	return []namedEngine{
		{purpose: transcription, engine: s.transcription},
		{purpose: translation, engine: s.translation},
		{purpose: voice, engine: s.voice},
	}
}

// logBrowserRuntime says what the browsers load, since no engine on this
// server is used.
func (s Settings) logBrowserRuntime() {
	if s.standIn() {
		log.Print("live translation runs in the browsers, on stand-in engines")

		return
	}

	log.Printf("live translation runs in the browsers, which load %s transcribe and %s translate from %s, with voices for %d languages",
		s.models.ASR.Model, s.models.MT.Model, envModelDir, len(s.models.Voices))
}

// standIn reports whether the engines are stand-ins. In the browser they
// stand in for the models too, which are then no files at all.
func (s Settings) standIn() bool {
	return s.transcription.provider == fake
}

func (s Settings) ready() bool {
	if s.runtime == runInBrowser {
		return s.models.problem == ""
	}

	return s.transcription.ready() && s.translation.ready() && s.voice.ready()
}

func (s Settings) external() bool {
	if s.runtime == runInBrowser {
		return false
	}

	return s.transcription.external || s.translation.external || s.voice.external
}

var (
	errEnginesMode    = errors.New(envEngines + " must be real or fake")
	errRuntimeMode    = errors.New(envRuntime + " must be server or browser")
	errTranslateValue = errors.New(envTranslateProvider + " must be ollama or openai-compatible")
	errFormatValue    = errors.New(envTranscribeFormat + " must be json or verbose_json")
	errNegative       = errors.New("must not be negative")
	errEngineURL      = errors.New("must be an http:// or https:// URL with a host")
	errDomain         = errors.New("must be domain names separated by commas")
)

// FromEnv reads the settings from the environment that getenv looks up.
func FromEnv(getenv func(string) string) (Settings, error) {
	env := environment(getenv)

	mode, err := env.runtime()
	if err != nil {
		return Settings{}, err
	}

	langs, err := env.languages()
	if err != nil {
		return Settings{}, err
	}

	format := responseFormat(env.or(envTranscribeFormat, string(formatJSON)))
	if format != formatJSON && format != formatVerbose {
		return Settings{}, fmt.Errorf("%w, not %q", errFormatValue, format)
	}

	settings := Settings{
		runtime:          mode,
		transcription:    standIn(),
		transcribeFormat: format,
		translation:      standIn(),
		voice:            standIn(),
		voiceName:        env(envVoiceName),
		interim:          0,
		glossary:         env("GLOSSARY"),
		languages:        langs,
		models:           noModels(""),
		modelDir:         env(envModelDir),
	}

	settings, err = env.chosenEngines(settings)
	if err != nil {
		return Settings{}, err
	}

	settings.models = env.loadModels(settings.modelDir, env(envModelsFile), langs)

	interimDefault := defaultInterim
	if settings.transcription.external {
		interimDefault = 0
	}

	settings.interim, err = env.duration(envInterim, time.Millisecond, interimDefault)
	if err != nil {
		return Settings{}, err
	}

	return settings, nil
}

// runtime reads which machine runs the engines: this server, as it always
// did, or every member's own browser.
func (env environment) runtime() (runtime, error) {
	switch mode := runtime(env.or(envRuntime, string(runOnServer))); mode {
	case runOnServer, runInBrowser:
		return mode, nil
	default:
		return "", fmt.Errorf("%w, not %q", errRuntimeMode, mode)
	}
}

func (env environment) chosenEngines(settings Settings) (Settings, error) {
	switch env.or(envEngines, "real") {
	case "fake":
		return settings, nil
	case "real":
		return env.realEngines(settings)
	default:
		return Settings{}, errEnginesMode
	}
}

func standIn() engine {
	return engine{provider: fake, endpoint: nil, apiKey: "", model: "", problem: "", external: false}
}

func (env environment) realEngines(settings Settings) (Settings, error) {
	internal, err := parseDomains(env(envInternalDomains))
	if err != nil {
		return Settings{}, err
	}

	engines := engineReader{env: env, internal: internal}

	settings.transcription, err = engines.openAICompatible(prefixTranscribe)
	if err != nil {
		return Settings{}, err
	}

	settings.translation, err = engines.translation()
	if err != nil {
		return Settings{}, err
	}

	settings.voice, err = engines.openAICompatible(prefixVoice)
	if err != nil {
		return Settings{}, err
	}

	if missing := settings.missingVoices(); settings.voice.ready() && len(missing) > 0 {
		settings.voice.problem = "a voice for " + strings.Join(missing, ", ")
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

func parseDomains(value string) ([]string, error) {
	if strings.TrimSpace(value) == "" {
		return nil, nil
	}

	parts := strings.Split(value, ",")
	domains := make([]string, 0, len(parts))

	for _, part := range parts {
		domain := strings.ToLower(strings.Trim(strings.TrimSpace(part), "."))
		if domain == "" || strings.ContainsAny(domain, "/:@ ") {
			return nil, fmt.Errorf("%s=%q %w", envInternalDomains, value, errDomain)
		}

		domains = append(domains, domain)
	}

	return domains, nil
}

type engineReader struct {
	env      environment
	internal []string
}

func (r engineReader) endpoint(prefix, fallback string) (*url.URL, error) {
	name := prefix + "_URL"

	parsed, err := url.Parse(strings.TrimRight(r.env.or(name, fallback), "/"))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}

	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, fmt.Errorf("%s=%q %w", name, parsed.Redacted(), errEngineURL)
	}

	return parsed, nil
}

func (r engineReader) openAICompatible(prefix string) (engine, error) {
	endpoint, err := r.endpoint(prefix, openAIURL)
	if err != nil {
		return engine{}, err
	}

	model := r.env(prefix + "_MODEL")

	problem := ""
	if model == "" {
		problem = prefix + "_MODEL"
	}

	return engine{
		provider: openAICompatible,
		endpoint: endpoint,
		apiKey:   r.env.or(prefix+"_API_KEY", r.env(envOpenAIKey)),
		model:    model,
		problem:  problem,
		external: isExternal(endpoint, r.internal),
	}, nil
}

func (r engineReader) translation() (engine, error) {
	chosen := provider(r.env.or(envTranslateProvider, string(ollama)))
	if chosen == openAICompatible {
		return r.openAICompatible(prefixTranslate)
	}

	if chosen != ollama {
		return engine{}, fmt.Errorf("%w, not %q", errTranslateValue, chosen)
	}

	endpoint, err := r.endpoint(prefixTranslate, defaultOllamaURL)
	if err != nil {
		return engine{}, err
	}

	model := r.env(prefixTranslate + "_MODEL")

	problem := ""
	if model == "" {
		problem = prefixTranslate + "_MODEL"
	}

	return engine{
		provider: ollama,
		endpoint: endpoint,
		apiKey:   "",
		model:    model,
		problem:  problem,
		external: isExternal(endpoint, r.internal),
	}, nil
}

func isExternal(endpoint *url.URL, internalDomains []string) bool {
	host := strings.ToLower(endpoint.Hostname())

	ip, err := netip.ParseAddr(host)
	if err == nil {
		return !ip.IsLoopback() && !ip.IsPrivate() && !ip.IsLinkLocalUnicast()
	}

	if host == "localhost" || !strings.Contains(host, ".") {
		return false
	}

	for _, domain := range append([]string{"local", "internal", "lan"}, internalDomains...) {
		if host == domain || strings.HasSuffix(host, "."+domain) {
			return false
		}
	}

	return true
}
