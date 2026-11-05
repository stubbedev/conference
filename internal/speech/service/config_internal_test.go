package service

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const (
	envTranscribeModel = prefixTranscribe + "_MODEL"
	envTranslateURL    = prefixTranslate + "_URL"
	envTranslateModel  = prefixTranslate + "_MODEL"
	envVoiceModel      = prefixVoice + "_MODEL"
	providerOpenAI     = string(openAICompatible)
	enginesFake        = "fake"
	modelTTS           = "tts"
	voiceAlloy         = "alloy"
	whisperURL         = "http://whisper:8080/v1"
)

func load(t *testing.T, values map[string]string) Settings {
	t.Helper()

	settings, err := FromEnv(func(name string) string {
		if name == envSecret {
			return "s"
		}

		return values[name]
	})
	if err != nil {
		t.Fatalf("settings from %v: %v", values, err)
	}

	return settings
}

func TestDefaultsNeedModels(t *testing.T) {
	t.Parallel()

	settings := load(t, nil)

	if settings.translation.provider != ollama || settings.translation.endpoint.String() != defaultOllamaURL {
		t.Fatalf("translation %+v, want Ollama on localhost", settings.translation)
	}

	for _, entry := range settings.engines() {
		if entry.engine.ready() {
			t.Fatalf("%s is ready without a model", entry.purpose)
		}
	}

	if !strings.Contains(settings.translation.problem, envTranslateModel) {
		t.Fatalf("translation problem %q does not name %s", settings.translation.problem, envTranslateModel)
	}
}

func TestTuningDefaults(t *testing.T) {
	t.Parallel()

	settings := load(t, nil)

	got := []any{settings.Addr, settings.silence, settings.maxSegment, settings.voiceRate}
	want := []any{"0.0.0.0:8090", 400 * time.Millisecond, 12 * time.Second, 24000}

	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("defaults %v, want %v", got, want)
		}
	}
}

func TestEverythingLocalIsReadyAndInternal(t *testing.T) {
	t.Parallel()

	settings := load(t, map[string]string{
		prefixTranscribe + "_URL": whisperURL,
		envTranscribeModel:        "whisper-1",
		envTranslateURL:           "http://10.0.0.5:11434/",
		envTranslateModel:         "some-model",
		prefixVoice + "_URL":      "http://localhost:8880/v1",
		envVoiceModel:             modelTTS,
		envVoiceName:              voiceAlloy,
	})

	if !settings.ready() || settings.external() {
		t.Fatalf("ready %v external %v, want ready and internal", settings.ready(), settings.external())
	}

	if settings.translation.endpoint.String() != "http://10.0.0.5:11434" {
		t.Fatalf("translation URL %q keeps its trailing slash", settings.translation.endpoint)
	}
}

func TestOpenAIForEverything(t *testing.T) {
	t.Parallel()

	settings := load(t, map[string]string{
		envOpenAIKey:         "k",
		envTranscribeModel:   "stt-model",
		envTranslateProvider: providerOpenAI,
		envTranslateModel:    "chat-model",
		envVoiceModel:        "tts-model",
		envVoiceName:         voiceAlloy,
	})

	if !settings.ready() {
		t.Fatalf("not ready: %+v", settings.engines())
	}

	for _, entry := range settings.engines() {
		use := entry.engine
		if use.provider != openAICompatible || use.endpoint.String() != openAIURL || use.apiKey != "k" || !use.external {
			t.Fatalf("%s: %+v, want OpenAI with the shared key, external", entry.purpose, use)
		}
	}
}

func TestVoiceNeedsVoiceNames(t *testing.T) {
	t.Parallel()

	settings := load(t, map[string]string{envVoiceModel: modelTTS})
	if settings.voice.ready() || !strings.Contains(settings.voice.problem, envVoiceName) {
		t.Fatalf("voice %+v, want a problem naming %s", settings.voice, envVoiceName)
	}

	path := filepath.Join(t.TempDir(), "languages.json")

	err := os.WriteFile(path, []byte(`[{"code":"en","name":"English","whisper":"en","voices":{"female":"nova","male":"onyx"}}]`), 0o600)
	if err != nil {
		t.Fatalf("write languages: %v", err)
	}

	settings = load(t, map[string]string{envVoiceModel: modelTTS, envLanguagesFile: path})
	if !settings.voice.ready() {
		t.Fatalf("voice %+v, want ready with voices in the languages file", settings.voice)
	}
}

func TestExternalOverride(t *testing.T) {
	t.Parallel()

	settings := load(t, map[string]string{
		envTranslateProvider:          providerOpenAI,
		envTranslateURL:               "https://llm.example.com/v1",
		envTranslateModel:             "m",
		prefixTranslate + "_EXTERNAL": "false",
	})
	if settings.translation.external {
		t.Fatal("TRANSLATE_EXTERNAL=false did not override")
	}

	settings = load(t, map[string]string{envTranslateURL: "http://gpu-box:11434", prefixTranslate + "_EXTERNAL": "TRUE"})
	if !settings.translation.external {
		t.Fatal("TRANSLATE_EXTERNAL=TRUE did not override")
	}
}

func TestFakeEnginesAreReady(t *testing.T) {
	t.Parallel()

	settings := load(t, map[string]string{envEngines: enginesFake})
	if !settings.ready() || settings.external() {
		t.Fatalf("fake engines: ready %v external %v", settings.ready(), settings.external())
	}
}

func TestInvalidSettingsFail(t *testing.T) {
	t.Parallel()

	cases := map[string]map[string]string{
		"no secret":         {},
		"engines mode":      {envSecret: "s", envEngines: "mock"},
		"translate":         {envSecret: "s", envTranslateProvider: "deepl"},
		"external":          {envSecret: "s", prefixVoice + "_EXTERNAL": "maybe"},
		"silence":           {envSecret: "s", "SILENCE_MS": "soon"},
		"negative segment":  {envSecret: "s", "MAX_SEGMENT_S": "-1"},
		"voice rate":        {envSecret: "s", "VOICE_RATE": "24k"},
		"missing languages": {envSecret: "s", envLanguagesFile: "/nonexistent/languages.json"},
	}

	for name, values := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			_, err := FromEnv(func(name string) string { return values[name] })
			if err == nil {
				t.Fatalf("%v loaded, want an error", values)
			}
		})
	}
}

func TestParseLanguagesRejects(t *testing.T) {
	t.Parallel()

	cases := map[string]string{
		"not json":     `{`,
		"empty":        `[]`,
		"no whisper":   `[{"code":"en","name":"English"}]`,
		"duplicate":    `[{"code":"en","name":"English","whisper":"en"},{"code":"en","name":"E","whisper":"en"}]`,
		"voice choice": `[{"code":"en","name":"English","whisper":"en","voices":{"robot":"r2"}}]`,
	}

	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			t.Parallel()

			_, err := parseLanguages([]byte(data))
			if err == nil {
				t.Fatalf("%s parsed, want an error", data)
			}
		})
	}
}

func TestShippedLanguagesParse(t *testing.T) {
	t.Parallel()

	langs, err := parseLanguages(defaultLanguages)
	if err != nil {
		t.Fatalf("languages.json: %v", err)
	}

	if first := langs.all()[0]; first.Code != "en" {
		t.Fatalf("first language %s, want English first", first.Code)
	}
}

func externalByURL(t *testing.T, address string) bool {
	t.Helper()

	parsed, err := url.Parse(address)
	if err != nil {
		t.Fatalf("parse %s: %v", address, err)
	}

	return isExternal(parsed)
}

func TestIsExternal(t *testing.T) {
	t.Parallel()

	internal := []string{
		"http://localhost:1", "http://127.0.0.1", "http://192.168.1.2", "http://[::1]:8", "http://[fd00::1]",
		"http://gpu", "http://box.local", "http://llm.internal", "http://nas.lan", "http://169.254.1.1",
	}
	for _, address := range internal {
		if externalByURL(t, address) {
			t.Errorf("%s counted as external", address)
		}
	}

	for _, address := range []string{openAIURL, "http://8.8.8.8", "https://llm.example.com", "http://[2001:db8::1]"} {
		if !externalByURL(t, address) {
			t.Errorf("%s counted as internal", address)
		}
	}
}

func TestEngineURLsMustBeHTTP(t *testing.T) {
	t.Parallel()

	for _, address := range []string{"ftp://files.example.com", "localhost:11434", "http://", "::"} {
		_, err := FromEnv(lookup(map[string]string{envSecret: "s", envTranslateURL: address}))
		if err == nil {
			t.Errorf("%s=%q loaded, want an error", envTranslateURL, address)
		}
	}
}

func TestInterimDefaultFollowsWhereTranscriptionRuns(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		values map[string]string
		want   time.Duration
	}{
		{name: "external", values: map[string]string{}, want: 0},
		{name: "internal", values: map[string]string{prefixTranscribe + "_URL": whisperURL}, want: defaultInterim},
		{name: "fake", values: map[string]string{envEngines: enginesFake}, want: defaultInterim},
		{name: "explicit", values: map[string]string{envInterim: "250"}, want: 250 * time.Millisecond},
		{name: "explicitly off", values: map[string]string{prefixTranscribe + "_URL": whisperURL, envInterim: "0"}, want: 0},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			if got := load(t, tc.values).interim; got != tc.want {
				t.Fatalf("interim %v, want %v", got, tc.want)
			}
		})
	}
}

func TestTranscribeResponseFormat(t *testing.T) {
	t.Parallel()

	if got := load(t, nil).transcribeFormat; got != formatJSON {
		t.Fatalf("default format %q, want json", got)
	}

	if got := load(t, map[string]string{envTranscribeFormat: "verbose_json"}).transcribeFormat; got != formatVerbose {
		t.Fatalf("format %q, want verbose_json", got)
	}

	_, err := FromEnv(lookup(map[string]string{envSecret: "s", envTranscribeFormat: "srt"}))
	if err == nil {
		t.Fatal("srt loaded, want an error")
	}
}

func lookup(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}
