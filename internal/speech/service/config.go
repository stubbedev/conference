// Package service is the speech service behind live translation: each
// speaking member's browser streams its microphone here, and gets back
// subtitles and a translated voice for every listener language.
package service

import (
	"errors"
	"fmt"
	"log"
	"math"
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
	audioCPP         provider = "audio.cpp"
)

type purpose string

const (
	transcription purpose = "transcription"
	translation   purpose = "translation"
	voice         purpose = "voice"
	conversion    purpose = "voice conversion"
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
	// defaultCacheLimit is 15 GB, room for the default models' exports a
	// browser starts on with several languages.
	defaultCacheLimit = 15 * gigabyte

	envRuntime           = "SPEECH_RUNTIME"
	envEngines           = "SPEECH_ENGINES"
	envModelDir          = "SPEECH_MODEL_DIR"
	envModelsFile        = "SPEECH_MODELS_FILE"
	envModelCacheMax     = "SPEECH_MODEL_CACHE_MAX"
	envGlossary          = "GLOSSARY"
	envLanguagesFile     = "LANGUAGES_FILE"
	envOpenAIKey         = "OPENAI_API_KEY"
	envInternalDomains   = "INTERNAL_DOMAINS"
	envTranslateProvider = "TRANSLATE_PROVIDER"
	envTranscribeFormat  = "TRANSCRIBE_RESPONSE_FORMAT"
	envVoiceName         = "VOICE_NAME"
	envVoiceCloning      = "VOICE_CLONING"
	envConvertURL        = "VOICE_CONVERT_URL"
	envConvertModel      = "VOICE_CONVERT_MODEL"
	envConvertKey        = "VOICE_CONVERT_API_KEY"
	envInterim           = "INTERIM_MS"
	prefixTranscribe     = "TRANSCRIBE"
	prefixTranslate      = "TRANSLATE"
	prefixVoice          = "VOICE"
	prefixConvert        = "VOICE_CONVERT"
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
	// voiceCloning: the voice engine takes a reference recording
	// (voice_ref, reference_text), so a speaker can be heard in their own voice.
	voiceCloning bool
	// conversion, when set, turns the stock voice into the speaker's own
	// voice from their recording (audio.cpp's /tasks/run).
	conversion *engine
	interim    time.Duration
	prompt     Prompt
	languages  languages
	models     Models
	modelDir   string
	cacheLimit int64
	hub        *url.URL
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

func (s Settings) engines() []namedEngine {
	engines := []namedEngine{
		{purpose: transcription, engine: s.transcription},
		{purpose: translation, engine: s.translation},
		{purpose: voice, engine: s.voice},
	}

	if s.conversion != nil {
		engines = append(engines, namedEngine{purpose: conversion, engine: *s.conversion})
	}

	return engines
}

// ownVoice says whether a speaker can be heard in their own voice: the
// voice engine clones it, or a conversion engine makes it. The browser
// runtime makes no voices on the server, so never there.
func (s Settings) ownVoice() bool {
	return s.runtime != runInBrowser && (s.voiceCloning || s.conversion != nil)
}

// logBrowserRuntime says what the browsers load, since no engine on this
// server is used.
func (s Settings) logBrowserRuntime() {
	if s.standIn() {
		log.Print("live translation runs in the browsers, on stand-in engines")

		return
	}

	if s.models.problem != "" {
		log.Printf("live translation runs in the browsers, but is unavailable: it needs %s", s.models.problem)

		return
	}

	log.Printf("live translation runs in the browsers, which load %s transcribe and %s translate from %s, with voices for %d languages; "+
		"this server fetches each file from %s once and keeps at most %d bytes of them",
		s.models.ASR.Model, s.models.MT.Model, envModelDir, len(s.models.Voices), s.hub.Redacted(), s.cacheLimit)
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

	return s.transcription.external || s.translation.external || s.voice.external ||
		(s.conversion != nil && s.conversion.external)
}

var (
	errEnginesMode    = errors.New(envEngines + " must be real or fake")
	errRuntimeMode    = errors.New(envRuntime + " must be server or browser")
	errTranslateValue = errors.New(envTranslateProvider + " must be ollama or openai-compatible")
	errFormatValue    = errors.New(envTranscribeFormat + " must be json or verbose_json")
	errNegative       = errors.New("must not be negative")
	errEngineURL      = errors.New("must be an http:// or https:// URL with a host")
	errDomain         = errors.New("must be domain names separated by commas")
	errCloningValue   = errors.New(envVoiceCloning + " must be true or false")
	errConvertHalf    = errors.New(envConvertURL + " and " + envConvertModel + " must be set together")
	errOwnVoiceTwice  = errors.New("set " + envVoiceCloning + " or " + envConvertURL + ", not both")
	errByteSize       = errors.New("must be a whole number of bytes with a unit, e.g. 15GB or 512MiB")
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

	cacheLimit, hub, err := env.modelCache()
	if err != nil {
		return Settings{}, err
	}

	settings := Settings{
		runtime:          mode,
		transcription:    standIn(),
		transcribeFormat: format,
		translation:      standIn(),
		voice:            standIn(),
		voiceName:        env(envVoiceName),
		voiceCloning:     false,
		conversion:       nil,
		interim:          0,
		prompt:           newPrompt(env(envGlossary), langs),
		languages:        langs,
		models:           noModels(""),
		modelDir:         env(envModelDir),
		cacheLimit:       cacheLimit,
		hub:              hub,
	}

	settings, err = env.chosenEngines(settings)
	if err != nil {
		return Settings{}, err
	}

	settings.models = env.loadModels(settings.modelDir, env(envModelsFile), langs, settings.prompt)

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

// ownVoice reads whether the voice engine clones voices; a conversion
// engine, read with the others, is the other way, and only one may be set.
func (env environment) ownVoice(settings Settings) (Settings, error) {
	cloning, err := env.flag(envVoiceCloning, errCloningValue)
	if err != nil {
		return Settings{}, err
	}

	if cloning && settings.conversion != nil {
		return Settings{}, errOwnVoiceTwice
	}

	settings.voiceCloning = cloning

	return settings, nil
}

func (env environment) chosenEngines(settings Settings) (Settings, error) {
	switch env.or(envEngines, "real") {
	case "fake":
		return env.ownVoice(settings)
	case "real":
		withEngines, err := env.realEngines(settings)
		if err != nil {
			return Settings{}, err
		}

		return env.ownVoice(withEngines)
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

	settings.conversion, err = engines.conversion()
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

func (env environment) flag(name string, invalid error) (bool, error) {
	switch value := env(name); value {
	case "", "false", "0":
		return false, nil
	case "true", "1":
		return true, nil
	default:
		return false, fmt.Errorf("%w, not %q", invalid, value)
	}
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

// modelCache reads how much of the model files the cache keeps, and the
// hub it fetches them from.
func (env environment) modelCache() (int64, *url.URL, error) {
	limit, err := env.byteSize(envModelCacheMax, defaultCacheLimit)
	if err != nil {
		return 0, nil, err
	}

	hub, err := url.Parse(huggingFace)
	if err != nil {
		return 0, nil, fmt.Errorf("the hub's address %s: %w", huggingFace, err)
	}

	return limit, hub, nil
}

// byteSize reads a number of bytes such as 15GB or 512MiB: a whole
// number with a decimal (kB, MB, GB, TB) or binary (KiB, MiB, GiB, TiB)
// unit, or none for bytes.
func (env environment) byteSize(name string, fallback int64) (int64, error) {
	value := strings.TrimSpace(env(name))
	if value == "" {
		return fallback, nil
	}

	digits := strings.TrimRightFunc(value, func(r rune) bool { return r < '0' || r > '9' })
	unit := strings.TrimSpace(value[len(digits):])

	scale, ok := byteUnits()[unit]
	if !ok || digits == "" {
		return 0, fmt.Errorf("%s=%q %w", name, value, errByteSize)
	}

	number, err := strconv.ParseInt(digits, 10, 64)
	if err != nil || number < 0 || number > math.MaxInt64/scale {
		return 0, fmt.Errorf("%s=%q %w", name, value, errByteSize)
	}

	return number * scale, nil
}

func byteUnits() map[string]int64 {
	return map[string]int64{
		"": 1, "B": 1,
		"kB": kilobyte, "KB": kilobyte, "MB": megabyte, "GB": gigabyte, "TB": terabyte,
		"KiB": kibibyte, "MiB": mebibyte, "GiB": gibibyte, "TiB": tebibyte,
	}
}

const (
	kilobyte = 1000
	megabyte = kilobyte * kilobyte
	gigabyte = megabyte * kilobyte
	terabyte = gigabyte * kilobyte
	kibibyte = 1024
	mebibyte = kibibyte * kibibyte
	gibibyte = mebibyte * kibibyte
	tebibyte = gibibyte * kibibyte
)

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

// conversion is the optional voice conversion engine: none unless both
// its address and model are set, with no default address to send voices to.
func (r engineReader) conversion() (*engine, error) {
	if r.env(envConvertURL) == "" && r.env(envConvertModel) == "" {
		return nil, nil //nolint:nilnil // No conversion engine is a valid setting.
	}

	if r.env(envConvertURL) == "" || r.env(envConvertModel) == "" {
		return nil, errConvertHalf
	}

	endpoint, err := r.endpoint(prefixConvert, "")
	if err != nil {
		return nil, err
	}

	return &engine{
		provider: audioCPP,
		endpoint: endpoint,
		apiKey:   r.env(envConvertKey),
		model:    r.env(envConvertModel),
		problem:  "",
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
