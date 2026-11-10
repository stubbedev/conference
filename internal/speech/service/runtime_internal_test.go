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
// a directory with the config and the encoder-decoder exports a browser
// loads, on a GPU and on the CPU, and the two voices the choices name.
func modelDir(t *testing.T, models ...string) string {
	t.Helper()

	dir := t.TempDir()

	for _, model := range models {
		writeModel(t, dir, model, kindSeq2Seq, halvesDtype, "q4", cpuDtype)
	}

	for _, voice := range []string{voiceLessac, voiceDanish} {
		writeFile(t, filepath.Join(dir, piperDir, voice+voiceModel), "{}")
		writeFile(t, filepath.Join(dir, piperDir, voice+voiceJSON), "{}")
	}

	return dir
}

func writeModel(t *testing.T, dir, model string, kind Kind, dtypes ...string) {
	t.Helper()

	root := filepath.Join(dir, filepath.FromSlash(model))
	writeFile(t, filepath.Join(root, modelConfig), "{}")

	for _, dtype := range dtypes {
		for _, name := range exportFiles(kind, dtypeSuffixes()[dtype]) {
			writeFile(t, filepath.Join(root, filepath.FromSlash(name)), "onnx")
		}
	}
}

func writeFile(t *testing.T, file, content string) {
	t.Helper()

	err := os.MkdirAll(filepath.Dir(file), 0o750)
	if err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	err = os.WriteFile(file, []byte(content), 0o600)
	if err != nil {
		t.Fatalf("write %s: %v", file, err)
	}
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
		ASR: ASRChoice{
			ModelChoice: ModelChoice{Model: asrModel, Dtype: halvesDtype, Languages: map[string]string{"da": danish}},
			Fallback:    nil,
		},
		MT:  MTChoice{Kind: kindSeq2Seq, Model: mtModel, Dtype: "q4", Fallback: nil, Pairs: nil, Builtin: false},
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

const (
	halvesDtype = "q4f16"
	llmModel    = "onnx-community/Qwen3-1.7B-ONNX"
	pairModel   = "Xenova/opus-mt-en-da"
	baseModel   = "onnx-community/whisper-base"
)

func browserStatus(t *testing.T, dir string, choices modelFile) Status {
	t.Helper()

	return load(t, map[string]string{
		envRuntime:    runtimeBrowser,
		envModelDir:   dir,
		envModelsFile: modelsFile(t, choices),
	}).Status()
}

func TestBrowserRuntimeNeedsTheExportItRunsOnTheCPU(t *testing.T) {
	t.Parallel()

	dir := modelDir(t, danish, mtModel)
	writeModel(t, dir, asrModel, kindSeq2Seq, halvesDtype)

	status := browserStatus(t, dir, browserChoices())
	if status.Available || !strings.Contains(status.Reason, "on the CPU") || !strings.Contains(status.Reason, "encoder_model_quantized.onnx") {
		t.Fatalf("available %v reason %q, want a refusal naming the 8-bit export", status.Available, status.Reason)
	}
}

func TestBrowserRuntimeReportsEveryExportOnDiskAndNoOther(t *testing.T) {
	t.Parallel()

	dir := modelDir(t, asrModel, danish, mtModel)
	writeModel(t, dir, mtModel, kindSeq2Seq, "fp32")

	status := browserStatus(t, dir, browserChoices())
	if !status.Available {
		t.Fatalf("unavailable: %s", status.Reason)
	}

	if _, ok := status.Models.Sizes[exportKey(mtModel, "fp32")]; !ok {
		t.Errorf("sizes %v lack the fp32 export on disk, which the GPU ladder may need", status.Models.Sizes)
	}

	if _, ok := status.Models.Sizes[exportKey(mtModel, "fp16")]; ok {
		t.Errorf("sizes %v list an fp16 export that is not on disk", status.Models.Sizes)
	}
}

func TestBrowserRuntimeReportsWhatEachModelWeighs(t *testing.T) {
	t.Parallel()

	dir := modelDir(t, asrModel, danish, mtModel)
	writeFile(t, filepath.Join(dir, filepath.FromSlash(asrModel), "tokenizer.json"), "[]")
	writeFile(t, filepath.Join(dir, filepath.FromSlash(asrModel), "onnx", "encoder_model_q4f16.onnx_data"), "weights")

	status := browserStatus(t, dir, browserChoices())
	if !status.Available {
		t.Fatalf("unavailable: %s", status.Reason)
	}

	want := map[string]int64{
		exportKey(asrModel, halvesDtype): int64(len("{}") + len("[]") + 2*len("onnx") + len("weights")),
		exportKey(asrModel, cpuDtype):    int64(len("{}") + len("[]") + 2*len("onnx")),
		exportKey(danish, halvesDtype):   int64(len("{}") + 2*len("onnx")),
		exportKey(mtModel, "q4"):         int64(len("{}") + 2*len("onnx")),
		exportKey(mtModel, cpuDtype):     int64(len("{}") + 2*len("onnx")),
		piperDir + "/" + voiceLessac:     int64(2 * len("{}")),
		piperDir + "/" + voiceDanish:     int64(2 * len("{}")),
	}

	for model, size := range want {
		if status.Models.Sizes[model] != size {
			t.Errorf("%s weighs %d, want %d", model, status.Models.Sizes[model], size)
		}
	}
}

func TestBrowserRuntimeGivesALanguageModelItsPrompt(t *testing.T) {
	t.Parallel()

	dir := modelDir(t, asrModel, danish)
	writeModel(t, dir, llmModel, kindLLM, halvesDtype)

	choices := browserChoices()
	choices.MT = MTChoice{Kind: kindLLM, Model: llmModel, Dtype: halvesDtype, Fallback: nil, Pairs: nil, Builtin: true}

	settings := load(t, map[string]string{
		envRuntime:    runtimeBrowser,
		envModelDir:   dir,
		envModelsFile: modelsFile(t, choices),
		envGlossary:   testGlossary,
	})

	status := settings.Status()
	if !status.Available {
		t.Fatalf("unavailable: %s", status.Reason)
	}

	prompt := status.Models.Prompt
	if prompt == nil {
		t.Fatal("a language model has no prompt")
	}

	if !strings.Contains(prompt.Glossary, "Kontainer") || prompt.Address["de"] == "" || !status.Models.MT.Builtin {
		t.Fatalf("prompt %+v builtin %v, want the glossary, German's address and the built-in translator", prompt, status.Models.MT.Builtin)
	}

	if browserStatus(t, modelDir(t, asrModel, danish, mtModel), browserChoices()).Models.Prompt != nil {
		t.Fatal("an encoder-decoder model has a prompt it cannot follow")
	}
}

func TestBrowserRuntimeChecksEveryPair(t *testing.T) {
	t.Parallel()

	dir := modelDir(t, asrModel, danish, mtModel, pairModel)

	for pair, refusal := range map[string]string{"en-da": "", "en-en": "en-en", "en-xx": "xx", "enda": "enda", "da-en": "mt.pairs.da-en"} {
		choices := browserChoices()

		model := pairModel
		if pair == "da-en" {
			model = "Xenova/opus-mt-da-en"
		}

		choices.MT.Pairs = map[string]Export{pair: {Model: model, Dtype: "q4"}}

		status := browserStatus(t, dir, choices)
		if refusal == "" && !status.Available {
			t.Errorf("%s: unavailable: %s", pair, status.Reason)
		}

		if refusal != "" && (status.Available || !strings.Contains(status.Reason, refusal)) {
			t.Errorf("%s: available %v reason %q, want a refusal naming %q", pair, status.Available, status.Reason, refusal)
		}
	}
}

func TestBrowserRuntimeChecksTheFallbackModel(t *testing.T) {
	t.Parallel()

	choices := browserChoices()
	choices.ASR.Fallback = &ModelChoice{Model: baseModel, Dtype: "q4", Languages: nil}

	status := browserStatus(t, modelDir(t, asrModel, danish, mtModel), choices)
	if status.Available || !strings.Contains(status.Reason, "asr.fallback") {
		t.Fatalf("available %v reason %q, want a refusal naming the fallback", status.Available, status.Reason)
	}

	if !browserStatus(t, modelDir(t, asrModel, danish, mtModel, baseModel), choices).Available {
		t.Fatal("unavailable with the fallback in place")
	}
}

func TestBrowserRuntimeNeedsTheKindOfTranslationModel(t *testing.T) {
	t.Parallel()

	choices := browserChoices()
	choices.MT.Kind = ""

	status := browserStatus(t, modelDir(t, asrModel, danish, mtModel), choices)
	if status.Available || !strings.Contains(status.Reason, "mt kind") {
		t.Fatalf("available %v reason %q, want a refusal naming the kind", status.Available, status.Reason)
	}
}

func TestBrowserRuntimeRunsTheFallbackOnTheCPU(t *testing.T) {
	t.Parallel()

	dir := modelDir(t, danish, mtModel, baseModel)
	writeModel(t, dir, asrModel, kindSeq2Seq, halvesDtype)

	choices := browserChoices()
	choices.ASR.Languages = nil
	choices.ASR.Fallback = &ModelChoice{Model: baseModel, Dtype: "q4", Languages: nil}

	status := browserStatus(t, dir, choices)
	if !status.Available {
		t.Fatalf("unavailable: %s, though the CPU runs the fallback", status.Reason)
	}
}

func TestBrowserRuntimeChecksTheTranslationFallback(t *testing.T) {
	t.Parallel()

	dir := modelDir(t, asrModel, danish)
	writeModel(t, dir, llmModel, kindLLM, halvesDtype)

	choices := browserChoices()
	fallback := &Export{Model: mtModel, Dtype: "q4"}
	choices.MT = MTChoice{Kind: kindLLM, Model: llmModel, Dtype: halvesDtype, Fallback: fallback, Pairs: nil, Builtin: false}

	status := browserStatus(t, dir, choices)
	if status.Available || !strings.Contains(status.Reason, "mt.fallback") {
		t.Fatalf("available %v reason %q, want a refusal naming the missing fallback", status.Available, status.Reason)
	}

	writeModel(t, dir, mtModel, kindSeq2Seq, "q4", cpuDtype)

	status = browserStatus(t, dir, choices)
	if !status.Available || status.Models.Sizes[exportKey(mtModel, "q4")] == 0 {
		t.Fatalf("available %v reason %q sizes %v, want the fallback weighed", status.Available, status.Reason, status.Models.Sizes)
	}

	choices.MT.Kind = kindSeq2Seq
	choices.MT.Model = mtModel
	choices.MT.Dtype = "q4"

	status = browserStatus(t, dir, choices)
	if status.Available || !strings.Contains(status.Reason, "mt fallback") {
		t.Fatalf("available %v reason %q, want an encoder-decoder model refused a fallback", status.Available, status.Reason)
	}
}

func TestBrowserRuntimeRefusesAFileNoBrowserCanLoad(t *testing.T) {
	t.Parallel()

	dir := modelDir(t, asrModel, danish, mtModel)
	encoder := filepath.Join(dir, filepath.FromSlash(mtModel), "onnx", "encoder_model_q4.onnx")

	err := os.Truncate(encoder, maxBrowserFile+1)
	if err != nil {
		t.Fatalf("grow the export: %v", err)
	}

	status := browserStatus(t, dir, browserChoices())
	refused := strings.Contains(status.Reason, "larger than a browser can load") && strings.Contains(status.Reason, "encoder_model_q4.onnx")

	if status.Available || !refused {
		t.Fatalf("available %v reason %q, want a refusal naming the file", status.Available, status.Reason)
	}
}

func TestBrowserRuntimeWeighsATranslatorWithEveryShard(t *testing.T) {
	t.Parallel()

	const translator = "onnx-community/translategemma-text-4b-it-ONNX"

	dir := modelDir(t, asrModel, danish)
	writeModel(t, dir, translator, kindTranslator, halvesDtype)
	writeModel(t, dir, mtModel, kindSeq2Seq, "q4", cpuDtype)

	weights := filepath.Join(dir, filepath.FromSlash(translator), "onnx", "model_q4f16.onnx")
	writeFile(t, weights+"_data", "shard0")
	writeFile(t, weights+"_data_1", "shard-1")
	writeFile(t, weights+"_data_3", "stray")

	choices := browserChoices()
	fallback := &Export{Model: mtModel, Dtype: "q4"}
	choices.MT = MTChoice{Kind: kindTranslator, Model: translator, Dtype: halvesDtype, Fallback: fallback, Pairs: nil, Builtin: false}

	status := browserStatus(t, dir, choices)
	if !status.Available {
		t.Fatalf("unavailable: %s, though a translator needs no CPU export of its own", status.Reason)
	}

	want := int64(len("{}") + len("onnx") + len("shard0") + len("shard-1"))
	if got := status.Models.Sizes[exportKey(translator, halvesDtype)]; got != want {
		t.Errorf("the translator weighs %d, want %d with both shards in a row", got, want)
	}

	if status.Models.Prompt != nil {
		t.Error("a translator has a prompt, though it only follows its own")
	}
}
