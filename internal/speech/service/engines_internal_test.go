package service

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/stubbe/conference/internal/speech/vad"
	"github.com/stubbe/conference/internal/speech/wav"
)

const (
	bearer        = "Bearer key"
	helloGerman   = "hallo welt"
	voiceTestRate = 22050
)

type transcriptionSeen struct {
	model, language, format string
	samples                 int
	rate                    uint32
}

type apiSeen struct {
	mu            sync.Mutex
	auth          map[string]string
	transcription transcriptionSeen
	chat          chatRequest
	ollama        ollamaRequest
	speech        speechRequest
}

func (a *apiSeen) record(r *http.Request, apply func()) {
	a.mu.Lock()
	defer a.mu.Unlock()

	a.auth[r.URL.Path] = r.Header.Get("Authorization")

	apply()
}

func decodeInto(t *testing.T, r *http.Request, into any) {
	t.Helper()

	err := json.NewDecoder(r.Body).Decode(into)
	if err != nil {
		t.Errorf("decode %s: %v", r.URL.Path, err)
	}
}

func fakeAPI(t *testing.T) (*httptest.Server, *apiSeen) {
	t.Helper()

	seen := &apiSeen{
		mu:            sync.Mutex{},
		auth:          map[string]string{},
		transcription: transcriptionSeen{model: "", language: "", format: "", samples: 0, rate: 0},
		chat:          chatRequest{Model: "", Messages: nil},
		ollama:        ollamaRequest{Model: "", Stream: false, Think: false, Options: ollamaOptions{Temperature: 0}, Messages: nil},
		speech:        speechRequest{Model: "", Voice: "", Input: "", ResponseFormat: ""},
	}
	mux := http.NewServeMux()

	mux.HandleFunc("POST /v1/audio/transcriptions", transcriptionHandler(t, seen))

	mux.HandleFunc("POST /v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		seen.record(r, func() { decodeInto(t, r, &seen.chat) })

		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":" hello world "}}]}`)
	})

	mux.HandleFunc("POST /api/chat", func(w http.ResponseWriter, r *http.Request) {
		seen.record(r, func() { decodeInto(t, r, &seen.ollama) })

		_, _ = io.WriteString(w, `{"message":{"role":"assistant","content":"hej världen"}}`)
	})

	mux.HandleFunc("POST /v1/audio/speech", func(w http.ResponseWriter, r *http.Request) {
		seen.record(r, func() { decodeInto(t, r, &seen.speech) })

		voiced, err := wav.Encode([]int16{1, 2}, voiceTestRate)
		if err != nil {
			t.Errorf("encode the voice: %v", err)
		}

		_, _ = w.Write(voiced)
	})

	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)

	return server, seen
}

func openAISettings(t *testing.T, api *httptest.Server) Settings {
	t.Helper()

	return load(t, map[string]string{
		prefixTranscribe + "_URL": api.URL + "/v1",
		envTranslateURL:           api.URL + "/v1",
		prefixVoice + "_URL":      api.URL + "/v1",
		envOpenAIKey:              "key",
		envTranscribeModel:        "stt",
		envTranslateProvider:      providerOpenAI,
		envTranslateModel:         "chat",
		envVoiceModel:             modelTTS,
		envVoiceName:              voiceAlloy,
		"GLOSSARY":                testGlossary,
	})
}

func mustLanguage(t *testing.T, settings Settings, code string) language {
	t.Helper()

	lang, ok := settings.languages.get(code)
	if !ok {
		t.Fatalf("no language %s", code)
	}

	return lang
}

func TestOpenAITranscription(t *testing.T) {
	t.Parallel()

	api, seen := fakeAPI(t)
	settings := openAISettings(t, api)

	text, err := newHTTPEngines(settings).transcribe(t.Context(), make([]int16, vad.Rate/10), mustLanguage(t, settings, "de"))
	if err != nil || text != helloGerman {
		t.Fatalf("transcribe: %q, %v", text, err)
	}

	want := transcriptionSeen{model: "stt", language: "de", format: "json", samples: vad.Rate / 10, rate: vad.Rate}
	if seen.transcription != want || seen.auth["/v1/audio/transcriptions"] != bearer {
		t.Fatalf("request %+v with %q, want %+v with the key", seen.transcription, seen.auth, want)
	}
}

func TestOpenAITranslation(t *testing.T) {
	t.Parallel()

	api, seen := fakeAPI(t)
	settings := openAISettings(t, api)

	text, err := newHTTPEngines(settings).translate(t.Context(), helloGerman,
		mustLanguage(t, settings, "de"), mustLanguage(t, settings, "fr"), []string{"a", "b", "c", "d"})
	if err != nil || text != "hello world" {
		t.Fatalf("translate: %q, %v", text, err)
	}

	if seen.chat.Model != "chat" || len(seen.chat.Messages) != 2 || seen.chat.Messages[1].Content != helloGerman {
		t.Fatalf("chat request %+v", seen.chat)
	}

	system := seen.chat.Messages[0].Content

	wants := []string{"spoken German", "natural spoken French", `"vous", never "tu"`, testGlossary, "context only: b c d"}
	for _, want := range wants {
		if !strings.Contains(system, want) {
			t.Fatalf("system prompt %q lacks %q", system, want)
		}
	}
}

func TestOpenAIVoice(t *testing.T) {
	t.Parallel()

	api, seen := fakeAPI(t)
	settings := openAISettings(t, api)

	spoken, err := newHTTPEngines(settings).speak(t.Context(), "hello world", mustLanguage(t, settings, "en"), voiceMale)
	if err != nil || len(spoken.pcm) != 4 || spoken.rate != voiceTestRate {
		t.Fatalf("speak: %+v, %v", spoken, err)
	}

	want := speechRequest{Model: modelTTS, Voice: voiceAlloy, Input: "hello world", ResponseFormat: "wav"}
	if seen.speech != want || seen.auth["/v1/audio/speech"] != bearer {
		t.Fatalf("speech request %+v with %q, want %+v with the key", seen.speech, seen.auth, want)
	}
}

func TestOllamaTranslation(t *testing.T) {
	t.Parallel()

	api, seen := fakeAPI(t)
	settings := load(t, map[string]string{envTranslateURL: api.URL, envTranslateModel: "gemma"})

	text, err := newHTTPEngines(settings).translate(t.Context(), "hello world",
		mustLanguage(t, settings, "en"), mustLanguage(t, settings, "sv"), nil)
	if err != nil || text != "hej världen" {
		t.Fatalf("translate: %q, %v", text, err)
	}

	if seen.ollama.Model != "gemma" || seen.ollama.Stream || seen.ollama.Think || seen.auth["/api/chat"] != "" {
		t.Fatalf("ollama request %+v with %q", seen.ollama, seen.auth["/api/chat"])
	}

	system := seen.ollama.Messages[0].Content
	if !strings.Contains(system, `"du", never "ni"`) || strings.Contains(system, "context only") {
		t.Fatalf("system prompt %q", system)
	}
}

func TestEngineErrorsCarryStatus(t *testing.T) {
	t.Parallel()

	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "quota", http.StatusTooManyRequests)
	}))
	t.Cleanup(api.Close)

	settings := load(t, map[string]string{envTranslateURL: api.URL, envTranslateModel: "m"})
	english := mustLanguage(t, settings, "en")

	_, err := newHTTPEngines(settings).translate(t.Context(), "hi", english, english, nil)
	if err == nil || !strings.Contains(err.Error(), "429") || !strings.Contains(err.Error(), string(translation)) {
		t.Fatalf("error %v, want the purpose and status 429", err)
	}
}

func TestVerboseTranscriptionDropsNonSpeech(t *testing.T) {
	t.Parallel()

	reply := `{"text":"hallo thank you for watching","segments":[` +
		`{"text":" hallo ","no_speech_prob":0.1,"avg_logprob":-0.3},` +
		`{"text":"thank you for watching","no_speech_prob":0.9,"avg_logprob":-1.4},` +
		`{"text":"welt","no_speech_prob":0.8,"avg_logprob":-0.2}]}`

	var format string

	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		format = r.FormValue("response_format")

		_, _ = io.WriteString(w, reply)
	}))
	t.Cleanup(api.Close)

	settings := load(t, map[string]string{
		prefixTranscribe + "_URL": api.URL + "/v1",
		envTranscribeModel:        "whisper-1",
		envTranscribeFormat:       string(formatVerbose),
	})

	text, err := newHTTPEngines(settings).transcribe(t.Context(), make([]int16, vad.Rate/10), mustLanguage(t, settings, "de"))
	if err != nil || text != helloGerman {
		t.Fatalf("transcribe: %q, %v; want the segments Whisper does not mark as silence", text, err)
	}

	if format != string(formatVerbose) {
		t.Fatalf("response_format %q, want verbose_json", format)
	}
}

func TestEngineErrorsHideURLPasswords(t *testing.T) {
	t.Parallel()

	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "down", http.StatusBadGateway)
	}))
	t.Cleanup(api.Close)

	withPassword := strings.Replace(api.URL, "http://", "http://user:hunter2@", 1)
	settings := load(t, map[string]string{envTranslateURL: withPassword, envTranslateModel: "m"})
	english := mustLanguage(t, settings, "en")

	_, err := newHTTPEngines(settings).translate(t.Context(), "hi", english, english, nil)
	if err == nil || strings.Contains(err.Error(), "hunter2") || !strings.Contains(err.Error(), "502") {
		t.Fatalf("error %v, want status 502 without the password", err)
	}
}

func transcriptionHandler(t *testing.T, seen *apiSeen) http.HandlerFunc {
	t.Helper()

	return func(w http.ResponseWriter, r *http.Request) {
		file, _, err := r.FormFile("file")
		if err != nil {
			t.Errorf("transcription form: %v", err)

			return
		}

		data, _ := io.ReadAll(file)

		pcm, rate, err := wav.Decode(data)
		if err != nil {
			t.Errorf("transcription audio: %v", err)
		}

		seen.record(r, func() {
			seen.transcription = transcriptionSeen{
				model: r.FormValue("model"), language: r.FormValue("language"), format: r.FormValue("response_format"),
				samples: len(pcm), rate: rate,
			}
		})

		_, _ = io.WriteString(w, `{"text":"  hallo welt  "}`)
	}
}
