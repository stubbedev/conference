package service

import (
	"encoding/json"
	"maps"
	"net/http"
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
	piperRepo   = "rhasspy/piper-voices"

	testRevision = "0123456789abcdef0123456789abcdef01234567"
	configSize   = 2
	onnxSize     = 4
)

// listed is a manifest naming the given model ids, each with the config
// and the encoder-decoder exports a browser loads, on a GPU and on the
// CPU, and the two voices the choices name.
func listed(models ...string) map[string]manifestEntry {
	files := map[string]manifestEntry{}

	for _, model := range models {
		listModel(files, model, kindSeq2Seq, halvesDtype, "q4", cpuDtype)
	}

	for _, voice := range []string{voiceLessac, voiceDanish} {
		for _, suffix := range []string{voiceModel, voiceJSON} {
			files[piperDir+"/"+voice+suffix] = manifestEntry{
				Repo: piperRepo, Revision: testRevision, File: "voices/" + voice + suffix, Size: configSize, SHA256: "", MD5: "",
			}
		}
	}

	return files
}

func listModel(files map[string]manifestEntry, model string, kind Kind, dtypes ...string) {
	listFile(files, model, modelConfig, configSize)

	for _, dtype := range dtypes {
		for _, name := range exportFiles(kind, dtypeSuffixes()[dtype]) {
			listFile(files, model, name, onnxSize)
		}
	}
}

func listFile(files map[string]manifestEntry, model, name string, size int64) {
	files[model+"/"+name] = manifestEntry{Repo: model, Revision: testRevision, File: name, Size: size, SHA256: "", MD5: ""}
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
		MT:    MTChoice{Kind: kindSeq2Seq, Model: mtModel, Dtype: "q4", Fallback: nil, Pairs: nil, Builtin: false},
		TTS:   map[string]string{"en": voiceLessac, "da": voiceDanish},
		Files: nil,
	}
}

// browserSettings loads the browser runtime with choices naming files,
// and any other settings in extra.
func browserSettings(t *testing.T, files map[string]manifestEntry, choices modelFile, extra map[string]string) Settings {
	t.Helper()

	choices.Files = files
	values := map[string]string{
		envRuntime:    runtimeBrowser,
		envModelDir:   t.TempDir(),
		envModelsFile: modelsFile(t, choices),
	}

	maps.Copy(values, extra)

	return load(t, values)
}

// started starts what settings run, failing the test when it cannot.
func started(t *testing.T, settings Settings) (*Service, http.Handler) {
	t.Helper()

	streams, files, err := Start(settings, nil)
	if err != nil {
		t.Fatalf("start: %v", err)
	}

	return streams, files
}

func browserStatus(t *testing.T, files map[string]manifestEntry, choices modelFile) Status {
	t.Helper()

	return browserSettings(t, files, choices, nil).Status()
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

	streams, files := started(t, settings)
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

	settings := browserSettings(t, listed(asrModel, danish, mtModel), browserChoices(), nil)
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

	streams, files := started(t, settings)
	if streams != nil || files == nil {
		t.Fatalf("started %v and %v, want the model files only", streams, files)
	}
}

func TestBrowserRuntimeNeedsTheManifest(t *testing.T) {
	t.Parallel()

	status := browserStatus(t, nil, browserChoices())
	if status.Available || !strings.Contains(status.Reason, "files") || !strings.Contains(status.Reason, "fetch-speech-models") {
		t.Fatalf("available %v reason %q, want a refusal saying how to write the manifest", status.Available, status.Reason)
	}
}

func TestBrowserRuntimeWithoutModelFiles(t *testing.T) {
	t.Parallel()

	choices := browserChoices()
	choices.ASR.Languages = nil

	status := browserStatus(t, listed(asrModel), choices)
	if status.Available {
		t.Fatal("available with models missing from the manifest")
	}

	if !strings.Contains(status.Reason, mtModel) {
		t.Fatalf("reason %q does not name the missing model %s", status.Reason, mtModel)
	}
}

func TestBrowserRuntimeWithoutModelChoices(t *testing.T) {
	t.Parallel()

	settings := load(t, map[string]string{
		envRuntime:  runtimeBrowser,
		envModelDir: t.TempDir(),
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

	status := browserStatus(t, listed(asrModel, danish, mtModel), choices)
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
		envModelDir:   t.TempDir(),
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

	streams, files := started(t, settings)
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

const (
	halvesDtype = "q4f16"
	llmModel    = "onnx-community/Qwen3-1.7B-ONNX"
	pairModel   = "Xenova/opus-mt-en-da"
	baseModel   = "onnx-community/whisper-base"
)

func TestBrowserRuntimeNeedsTheExportItRunsOnTheCPU(t *testing.T) {
	t.Parallel()

	files := listed(danish, mtModel)
	listModel(files, asrModel, kindSeq2Seq, halvesDtype)

	status := browserStatus(t, files, browserChoices())
	if status.Available || !strings.Contains(status.Reason, "on the CPU") || !strings.Contains(status.Reason, "encoder_model_quantized.onnx") {
		t.Fatalf("available %v reason %q, want a refusal naming the 8-bit export", status.Available, status.Reason)
	}
}

func TestBrowserRuntimeReportsEveryListedExportAndNoOther(t *testing.T) {
	t.Parallel()

	files := listed(asrModel, danish, mtModel)
	listModel(files, mtModel, kindSeq2Seq, "fp32")

	status := browserStatus(t, files, browserChoices())
	if !status.Available {
		t.Fatalf("unavailable: %s", status.Reason)
	}

	if _, ok := status.Models.Sizes[exportKey(mtModel, "fp32")]; !ok {
		t.Errorf("sizes %v lack the listed fp32 export, which the GPU ladder may need", status.Models.Sizes)
	}

	if _, ok := status.Models.Sizes[exportKey(mtModel, "fp16")]; ok {
		t.Errorf("sizes %v list an fp16 export the manifest does not", status.Models.Sizes)
	}
}

func TestBrowserRuntimeReportsWhatEachModelWeighs(t *testing.T) {
	t.Parallel()

	const (
		tokenizerSize = 3
		weightsSize   = 7
	)

	files := listed(asrModel, danish, mtModel)
	listFile(files, asrModel, "tokenizer.json", tokenizerSize)
	listFile(files, asrModel, "onnx/encoder_model_q4f16.onnx_data", weightsSize)
	listFile(files, asrModel, "onnx/encoder_model_q4f16.json", 1000)

	status := browserStatus(t, files, browserChoices())
	if !status.Available {
		t.Fatalf("unavailable: %s", status.Reason)
	}

	want := map[string]int64{
		exportKey(asrModel, halvesDtype): configSize + tokenizerSize + 2*onnxSize + weightsSize,
		exportKey(asrModel, cpuDtype):    configSize + tokenizerSize + 2*onnxSize,
		exportKey(danish, halvesDtype):   configSize + 2*onnxSize,
		exportKey(mtModel, "q4"):         configSize + 2*onnxSize,
		exportKey(mtModel, cpuDtype):     configSize + 2*onnxSize,
		piperDir + "/" + voiceLessac:     2 * configSize,
		piperDir + "/" + voiceDanish:     2 * configSize,
	}

	for model, size := range want {
		if status.Models.Sizes[model] != size {
			t.Errorf("%s weighs %d, want %d", model, status.Models.Sizes[model], size)
		}
	}
}

func TestBrowserRuntimeGivesALanguageModelItsPrompt(t *testing.T) {
	t.Parallel()

	files := listed(asrModel, danish)
	listModel(files, llmModel, kindLLM, halvesDtype)

	choices := browserChoices()
	choices.MT = MTChoice{Kind: kindLLM, Model: llmModel, Dtype: halvesDtype, Fallback: nil, Pairs: nil, Builtin: true}

	status := browserSettings(t, files, choices, map[string]string{envGlossary: testGlossary}).Status()
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

	if browserStatus(t, listed(asrModel, danish, mtModel), browserChoices()).Models.Prompt != nil {
		t.Fatal("an encoder-decoder model has a prompt it cannot follow")
	}
}

func TestBrowserRuntimeChecksEveryPair(t *testing.T) {
	t.Parallel()

	files := listed(asrModel, danish, mtModel, pairModel)

	for pair, refusal := range map[string]string{"en-da": "", "en-en": "en-en", "en-xx": "xx", "enda": "enda", "da-en": "mt.pairs.da-en"} {
		choices := browserChoices()

		model := pairModel
		if pair == "da-en" {
			model = "Xenova/opus-mt-da-en"
		}

		choices.MT.Pairs = map[string]Export{pair: {Model: model, Dtype: "q4"}}

		status := browserStatus(t, files, choices)
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

	status := browserStatus(t, listed(asrModel, danish, mtModel), choices)
	if status.Available || !strings.Contains(status.Reason, "asr.fallback") {
		t.Fatalf("available %v reason %q, want a refusal naming the fallback", status.Available, status.Reason)
	}

	if !browserStatus(t, listed(asrModel, danish, mtModel, baseModel), choices).Available {
		t.Fatal("unavailable with the fallback in place")
	}
}

func TestBrowserRuntimeNeedsTheKindOfTranslationModel(t *testing.T) {
	t.Parallel()

	choices := browserChoices()
	choices.MT.Kind = ""

	status := browserStatus(t, listed(asrModel, danish, mtModel), choices)
	if status.Available || !strings.Contains(status.Reason, "mt kind") {
		t.Fatalf("available %v reason %q, want a refusal naming the kind", status.Available, status.Reason)
	}
}

func TestBrowserRuntimeRunsTheFallbackOnTheCPU(t *testing.T) {
	t.Parallel()

	files := listed(danish, mtModel, baseModel)
	listModel(files, asrModel, kindSeq2Seq, halvesDtype)

	choices := browserChoices()
	choices.ASR.Languages = nil
	choices.ASR.Fallback = &ModelChoice{Model: baseModel, Dtype: "q4", Languages: nil}

	status := browserStatus(t, files, choices)
	if !status.Available {
		t.Fatalf("unavailable: %s, though the CPU runs the fallback", status.Reason)
	}
}

func TestBrowserRuntimeChecksTheTranslationFallback(t *testing.T) {
	t.Parallel()

	files := listed(asrModel, danish)
	listModel(files, llmModel, kindLLM, halvesDtype)

	choices := browserChoices()
	fallback := &Export{Model: mtModel, Dtype: "q4"}
	choices.MT = MTChoice{Kind: kindLLM, Model: llmModel, Dtype: halvesDtype, Fallback: fallback, Pairs: nil, Builtin: false}

	status := browserStatus(t, files, choices)
	if status.Available || !strings.Contains(status.Reason, "mt.fallback") {
		t.Fatalf("available %v reason %q, want a refusal naming the missing fallback", status.Available, status.Reason)
	}

	listModel(files, mtModel, kindSeq2Seq, "q4", cpuDtype)

	status = browserStatus(t, files, choices)
	if !status.Available || status.Models.Sizes[exportKey(mtModel, "q4")] == 0 {
		t.Fatalf("available %v reason %q sizes %v, want the fallback weighed", status.Available, status.Reason, status.Models.Sizes)
	}

	choices.MT.Kind = kindSeq2Seq
	choices.MT.Model = mtModel
	choices.MT.Dtype = "q4"

	status = browserStatus(t, files, choices)
	if status.Available || !strings.Contains(status.Reason, "mt fallback") {
		t.Fatalf("available %v reason %q, want an encoder-decoder model refused a fallback", status.Available, status.Reason)
	}
}

func TestBrowserRuntimeRefusesAFileNoBrowserCanLoad(t *testing.T) {
	t.Parallel()

	files := listed(asrModel, danish, mtModel)
	listFile(files, mtModel, "onnx/encoder_model_q4.onnx", maxBrowserFile+1)

	status := browserStatus(t, files, browserChoices())
	refused := strings.Contains(status.Reason, "larger than a browser can load") && strings.Contains(status.Reason, "encoder_model_q4.onnx")

	if status.Available || !refused {
		t.Fatalf("available %v reason %q, want a refusal naming the file", status.Available, status.Reason)
	}
}

func TestBrowserRuntimeWeighsATranslatorWithEveryShard(t *testing.T) {
	t.Parallel()

	const (
		translator = "onnx-community/translategemma-text-4b-it-ONNX"
		weights    = "onnx/model_q4f16.onnx"
		shard0     = 6
		shard1     = 7
	)

	files := listed(asrModel, danish)
	listModel(files, translator, kindTranslator, halvesDtype)
	listModel(files, mtModel, kindSeq2Seq, "q4", cpuDtype)
	listFile(files, translator, weights+"_data", shard0)
	listFile(files, translator, weights+"_data_1", shard1)
	listFile(files, translator, weights+"_data_3", 5)

	choices := browserChoices()
	fallback := &Export{Model: mtModel, Dtype: "q4"}
	choices.MT = MTChoice{Kind: kindTranslator, Model: translator, Dtype: halvesDtype, Fallback: fallback, Pairs: nil, Builtin: false}

	status := browserStatus(t, files, choices)
	if !status.Available {
		t.Fatalf("unavailable: %s, though a translator needs no CPU export of its own", status.Reason)
	}

	want := int64(configSize + onnxSize + shard0 + shard1)
	if got := status.Models.Sizes[exportKey(translator, halvesDtype)]; got != want {
		t.Errorf("the translator weighs %d, want %d with both shards in a row", got, want)
	}

	if status.Models.Prompt != nil {
		t.Error("a translator has a prompt, though it only follows its own")
	}
}
