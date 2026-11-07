package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const (
	runtimeBrowser = string(runInBrowser)
	runtimeServer  = string(runOnServer)

	asrModel    = "onnx-community/whisper-large-v3-turbo"
	mtModel     = "Xenova/m2m100_418M"
	danish      = "thorhojhus/whisper-large-v3-turbo-danish"
	voiceLessac = "en_US-lessac-medium"
	voiceDanish = "da_DK-talesyntese-medium"
)

// modelDir writes a model directory holding the given model ids, each as
// a directory with the config a browser loads a model from, and the two
// voices the choices name.
func modelDir(t *testing.T, models ...string) string {
	t.Helper()

	dir := t.TempDir()

	for _, model := range models {
		path := filepath.Join(dir, filepath.FromSlash(model))

		err := os.MkdirAll(path, 0o750)
		if err != nil {
			t.Fatalf("model dir: %v", err)
		}

		err = os.WriteFile(filepath.Join(path, modelConfig), []byte("{}"), 0o600)
		if err != nil {
			t.Fatalf("model config: %v", err)
		}
	}

	for _, voice := range []string{voiceLessac, voiceDanish} {
		err := os.MkdirAll(filepath.Join(dir, piperDir), 0o750)
		if err != nil {
			t.Fatalf("voices dir: %v", err)
		}

		for _, suffix := range []string{voiceModel, voiceJSON} {
			err = os.WriteFile(filepath.Join(dir, piperDir, voice+suffix), []byte("{}"), 0o600)
			if err != nil {
				t.Fatalf("voice: %v", err)
			}
		}
	}

	return dir
}

// modelsFile writes the model choices the browsers load and returns its
// path.
func modelsFile(t *testing.T, choices modelFile) string {
	t.Helper()

	data, err := json.Marshal(choices)
	if err != nil {
		t.Fatalf("models: %v", err)
	}

	path := filepath.Join(t.TempDir(), "models.json")

	err = os.WriteFile(path, data, 0o600)
	if err != nil {
		t.Fatalf("write models: %v", err)
	}

	return path
}

func browserChoices() modelFile {
	return modelFile{
		ASR: ModelChoice{Model: asrModel, Dtype: "q4f16", Languages: map[string]string{"da": danish}},
		MT:  ModelChoice{Model: mtModel, Dtype: "q8", Languages: nil},
		TTS: map[string]string{"en": voiceLessac, "da": voiceDanish},
	}
}

func TestBrowserRuntimeNeedsNoEngines(t *testing.T) {
	t.Parallel()

	settings := load(t, map[string]string{envRuntime: runtimeBrowser, envEngines: enginesFake})
	status := settings.Status()

	if !status.Available || status.Reason != "" {
		t.Fatalf("available %v reason %q, want available on stand-ins", status.Available, status.Reason)
	}

	if status.Mode != runtimeBrowser || !status.Fake || status.External {
		t.Fatalf("status %+v, want browser runtime on stand-ins", status)
	}

	if status.Models == nil || status.Models.Base != "" {
		t.Fatalf("models %+v, want none to load", status.Models)
	}

	streams, files := Start(settings, nil)
	if streams != nil || files != nil {
		t.Fatalf("started %v and %v, want neither on stand-ins", streams, files)
	}
}

func TestBrowserRuntimeWithoutModelDirectory(t *testing.T) {
	t.Parallel()

	settings := load(t, map[string]string{envRuntime: runtimeBrowser})
	status := settings.Status()

	if status.Available {
		t.Fatal("available without a model directory")
	}

	if !strings.Contains(status.Reason, envModelDir) {
		t.Fatalf("reason %q does not name %s", status.Reason, envModelDir)
	}
}

func TestBrowserRuntimeLoadsModels(t *testing.T) {
	t.Parallel()

	dir := modelDir(t, asrModel, danish, mtModel)
	settings := load(t, map[string]string{
		envRuntime:    runtimeBrowser,
		envModelDir:   dir,
		envModelsFile: modelsFile(t, browserChoices()),
	})
	status := settings.Status()

	if !status.Available || status.Reason != "" {
		t.Fatalf("available %v reason %q, want available", status.Available, status.Reason)
	}

	if status.Models == nil {
		t.Fatal("no models in the status")
	}

	if status.Models.Base != ModelsPath || status.Models.ASR.Model != asrModel {
		t.Fatalf("models %+v, want %s", status.Models, ModelsPath)
	}

	if status.Models.ASR.Languages["da"] != danish {
		t.Fatalf("asr languages %v, want the Danish model", status.Models.ASR.Languages)
	}

	if settings.ModelDir() != dir {
		t.Fatalf("model dir %q, want %q", settings.ModelDir(), dir)
	}

	streams, files := Start(settings, nil)
	if streams != nil || files == nil {
		t.Fatalf("started %v and %v, want the model files only", streams, files)
	}
}

func TestBrowserRuntimeWithoutModelFiles(t *testing.T) {
	t.Parallel()

	choices := browserChoices()
	choices.ASR.Languages = nil

	settings := load(t, map[string]string{
		envRuntime:    runtimeBrowser,
		envModelDir:   modelDir(t, asrModel),
		envModelsFile: modelsFile(t, choices),
	})

	status := settings.Status()
	if status.Available {
		t.Fatal("available with models missing from the directory")
	}

	if !strings.Contains(status.Reason, mtModel) {
		t.Fatalf("reason %q does not name the missing model %s", status.Reason, mtModel)
	}
}

func TestBrowserRuntimeWithoutModelChoices(t *testing.T) {
	t.Parallel()

	settings := load(t, map[string]string{
		envRuntime:  runtimeBrowser,
		envModelDir: modelDir(t, asrModel),
	})

	status := settings.Status()
	if status.Available {
		t.Fatal("available without model choices")
	}

	if !strings.Contains(status.Reason, envModelsFile) {
		t.Fatalf("reason %q does not name %s", status.Reason, envModelsFile)
	}
}

func TestBrowserRuntimeRejectsUnknownLanguage(t *testing.T) {
	t.Parallel()

	choices := browserChoices()
	choices.ASR.Languages = map[string]string{"xx": danish}

	settings := load(t, map[string]string{
		envRuntime:    runtimeBrowser,
		envModelDir:   modelDir(t, asrModel, danish, mtModel),
		envModelsFile: modelsFile(t, choices),
	})

	status := settings.Status()
	if status.Available || !strings.Contains(status.Reason, "xx") {
		t.Fatalf("available %v reason %q, want a refusal naming the language", status.Available, status.Reason)
	}
}

func TestBrowserRuntimeRejectsMalformedChoices(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "models.json")

	err := os.WriteFile(path, []byte(`{"asr":{"model":"whisper","dtype":"q8"}}`), 0o600)
	if err != nil {
		t.Fatalf("write models: %v", err)
	}

	settings := load(t, map[string]string{
		envRuntime:    runtimeBrowser,
		envModelDir:   modelDir(t),
		envModelsFile: path,
	})

	if settings.Status().Available {
		t.Fatal("available with a model id that names no owner")
	}
}

func TestServerRuntimeIgnoresModelSettings(t *testing.T) {
	t.Parallel()

	settings := load(t, map[string]string{envRuntime: runtimeServer, envModelDir: "nowhere"})
	status := settings.Status()

	if status.Mode != runtimeServer || status.Models != nil {
		t.Fatalf("status %+v, want the server runtime without models", status)
	}

	if settings.ModelDir() != "" {
		t.Fatalf("model dir %q, want none", settings.ModelDir())
	}

	streams, files := Start(settings, nil)
	if streams == nil || files != nil {
		t.Fatalf("started %v and %v, want the speech service only", streams, files)
	}
}

func TestRuntimeValue(t *testing.T) {
	t.Parallel()

	_, err := FromEnv(func(name string) string {
		if name == envRuntime {
			return "elsewhere"
		}

		return ""
	})
	if err == nil || !strings.Contains(err.Error(), envRuntime) {
		t.Fatalf("err %v, want a refusal naming %s", err, envRuntime)
	}
}

func TestModelFiles(t *testing.T) {
	t.Parallel()

	dir := modelDir(t, asrModel)

	files := newModelFiles(dir)
	target := ModelsPath + asrModel + "/" + modelConfig

	rec := httptest.NewRecorder()
	files.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, target, nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("GET %s: %d", target, rec.Code)
	}

	if cache := rec.Header().Get("Cache-Control"); !strings.Contains(cache, "immutable") {
		t.Fatalf("Cache-Control %q, want immutable", cache)
	}

	rec = httptest.NewRecorder()
	files.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodPost, target, nil))

	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST: %d, want 405", rec.Code)
	}

	rec = httptest.NewRecorder()
	files.ServeHTTP(rec, httptest.NewRequestWithContext(context.Background(), http.MethodGet, ModelsPath+"absent/config.json", nil))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("missing model: %d, want 404", rec.Code)
	}
}
