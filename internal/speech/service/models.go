package service

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"maps"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"
)

// The models a member's browser loads when the browsers run the engines:
// transcription and translation through transformers.js, and a Piper
// voice for each language. Every file comes from this server, never from
// a model hub at call time.

const (
	// ModelsPath is where this server serves the model directory the
	// browsers load from.
	ModelsPath = "/speech/"

	piperDir     = "piper"
	modelConfig  = "config.json"
	voiceModel   = ".onnx"
	voiceJSON    = ".onnx.json"
	externalData = "_data"
	cpuDtype     = "q8"

	maxBrowserFile = 2<<30 - 1

	modelIDParts = 2
	pairParts    = 2
)

var (
	errModelsJSON     = errors.New("is not valid JSON")
	errModelsMissing  = errors.New("is missing")
	errModelsDir      = errors.New("must be an owner and a name, e.g. onnx-community/whisper-large-v3-turbo")
	errModelsDtype    = errors.New("is not an export transformers.js loads")
	errModelsLanguage = errors.New("is not one of the languages live translation has")
	errModelsKind     = errors.New("must be " + string(kindSeq2Seq) + " or " + string(kindLLM))
	errModelsPair     = errors.New("must be two different languages, source-target, e.g. en-de")
	errVoiceName      = errors.New("must be a voice's name, letters, digits, dashes and dots")
	errModelsTooLarge = errors.New("is larger than a browser can load as one file")
	errModelsFallback = errors.New("is for a language model, which not every browser can run; an encoder-decoder model needs none")
)

func dtypeSuffixes() map[string]string {
	return map[string]string{
		"fp32":  "",
		"fp16":  "_fp16",
		"q8":    "_quantized",
		"int8":  "_int8",
		"uint8": "_uint8",
		"q4":    "_q4",
		"q4f16": "_q4f16",
		"bnb4":  "_bnb4",
		"q2":    "_q2",
		"q2f16": "_q2f16",
		"q1":    "_q1",
		"q1f16": "_q1f16",
	}
}

// Kind is how a translation model translates.
type Kind string

const (
	kindSeq2Seq Kind = "seq2seq"
	kindLLM     Kind = "llm"
)

// Export is a model and the export of it the browsers load.
type Export struct {
	Model string `json:"model"`
	Dtype string `json:"dtype"`
}

// ModelChoice is a transcription model and the languages with one of their own.
type ModelChoice struct {
	Model     string            `json:"model"`
	Dtype     string            `json:"dtype"`
	Languages map[string]string `json:"languages,omitempty"`
}

// ASRChoice is the transcription model and the smaller one to step down to.
type ASRChoice struct {
	ModelChoice

	Fallback *ModelChoice `json:"fallback,omitempty"`
}

// MTChoice is the translation model, the encoder-decoder model a browser that cannot run a language model
// translates with, the pairs with one of their own, and the built-in translator.
type MTChoice struct {
	Kind     Kind              `json:"kind"`
	Model    string            `json:"model"`
	Dtype    string            `json:"dtype"`
	Fallback *Export           `json:"fallback,omitempty"`
	Pairs    map[string]Export `json:"pairs,omitempty"`
	Builtin  bool              `json:"builtin,omitempty"`
}

// Models is what the browsers load, what it weighs, and the prompt a language model follows.
type Models struct {
	ASR    ASRChoice         `json:"asr"`
	MT     MTChoice          `json:"mt"`
	Voices map[string]string `json:"voices"`
	Sizes  map[string]int64  `json:"sizes"`
	Prompt *Prompt           `json:"prompt,omitempty"`

	// Base is the path the files are served from, empty when the browsers
	// run stand-in engines; problem says why they cannot load at all.
	Base    string `json:"base"`
	problem string
}

type modelFile struct {
	ASR ASRChoice         `json:"asr"`
	MT  MTChoice          `json:"mt"`
	TTS map[string]string `json:"tts"`
}

func noModels(problem string) Models {
	return Models{
		ASR:     ASRChoice{ModelChoice: ModelChoice{Model: "", Dtype: "", Languages: nil}, Fallback: nil},
		MT:      MTChoice{Kind: "", Model: "", Dtype: "", Fallback: nil, Pairs: nil, Builtin: false},
		Voices:  nil,
		Sizes:   nil,
		Prompt:  nil,
		Base:    "",
		problem: problem,
	}
}

func (env environment) loadModels(dir, modelsFile string, available languages, prompt Prompt) Models {
	if env(envEngines) == "fake" {
		return noModels("")
	}

	if dir == "" {
		return noModels(envModelDir + " is missing")
	}

	file, err := readModelFile(modelsFile)
	if err != nil {
		return noModels(fmt.Sprintf("%s: %v", envModelsFile, err))
	}

	sizes, err := checkModelFile(dir, file, available)
	if err != nil {
		return noModels(fmt.Sprintf("%s: %v", envModelsFile, err))
	}

	models := Models{ASR: file.ASR, MT: file.MT, Voices: file.TTS, Sizes: sizes, Prompt: nil, Base: ModelsPath, problem: ""}
	if file.MT.Kind == kindLLM {
		translating := prompt.clone()
		models.Prompt = &translating
	}

	return models
}

func readModelFile(name string) (modelFile, error) {
	var file modelFile

	if name == "" {
		return file, fmt.Errorf("%s %w", envModelsFile, errModelsMissing)
	}

	data, err := os.ReadFile(name) //nolint:gosec // The operator names this file.
	if err != nil {
		return file, fmt.Errorf("read: %w", err)
	}

	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()

	err = decoder.Decode(&file)
	if err != nil {
		return file, fmt.Errorf("%w: %w", errModelsJSON, err)
	}

	return file, nil
}

func checkModelFile(dir string, file modelFile, available languages) (map[string]int64, error) {
	sizes := make(map[string]int64)

	err := checkTranscription(dir, "asr", file.ASR.ModelChoice, available, file.ASR.Fallback == nil, sizes)
	if err != nil {
		return nil, err
	}

	if file.ASR.Fallback != nil {
		err = checkTranscription(dir, "asr.fallback", *file.ASR.Fallback, available, true, sizes)
		if err != nil {
			return nil, err
		}
	}

	err = checkTranslation(dir, file.MT, available, sizes)
	if err != nil {
		return nil, err
	}

	err = checkVoices(dir, file.TTS, available, sizes)
	if err != nil {
		return nil, err
	}

	return sizes, nil
}

func checkTranscription(dir, purpose string, choice ModelChoice, available languages, cpu bool, sizes map[string]int64) error {
	err := checkExport(dir, purpose, kindSeq2Seq, Export{Model: choice.Model, Dtype: choice.Dtype}, cpu, sizes)
	if err != nil {
		return err
	}

	for _, code := range slices.Sorted(maps.Keys(choice.Languages)) {
		if _, ok := available.get(code); !ok {
			return fmt.Errorf("%s %q %w", purpose, code, errModelsLanguage)
		}

		err = checkExport(dir, purpose+"."+code, kindSeq2Seq, Export{Model: choice.Languages[code], Dtype: choice.Dtype}, cpu, sizes)
		if err != nil {
			return err
		}
	}

	return nil
}

func checkTranslation(dir string, choice MTChoice, available languages, sizes map[string]int64) error {
	if choice.Kind != kindSeq2Seq && choice.Kind != kindLLM {
		return fmt.Errorf("mt kind %q %w", choice.Kind, errModelsKind)
	}

	err := checkExport(dir, "mt", choice.Kind, Export{Model: choice.Model, Dtype: choice.Dtype}, choice.Kind == kindSeq2Seq, sizes)
	if err != nil {
		return err
	}

	if choice.Fallback != nil {
		if choice.Kind != kindLLM {
			return fmt.Errorf("mt fallback %w", errModelsFallback)
		}

		err = checkExport(dir, "mt.fallback", kindSeq2Seq, *choice.Fallback, true, sizes)
		if err != nil {
			return err
		}
	}

	for _, pair := range slices.Sorted(maps.Keys(choice.Pairs)) {
		err = checkPair(pair, available)
		if err != nil {
			return err
		}

		err = checkExport(dir, "mt.pairs."+pair, kindSeq2Seq, choice.Pairs[pair], true, sizes)
		if err != nil {
			return err
		}
	}

	return nil
}

func checkPair(pair string, available languages) error {
	codes := strings.Split(pair, "-")
	if len(codes) != pairParts || codes[0] == codes[1] {
		return fmt.Errorf("mt pair %q %w", pair, errModelsPair)
	}

	for _, code := range codes {
		if _, ok := available.get(code); !ok {
			return fmt.Errorf("mt pair %q: %q %w", pair, code, errModelsLanguage)
		}
	}

	return nil
}

func exportFiles(kind Kind, suffix string) []string {
	if kind == kindLLM {
		return []string{"onnx/model" + suffix + ".onnx"}
	}

	return []string{"onnx/encoder_model" + suffix + ".onnx", "onnx/decoder_model_merged" + suffix + ".onnx"}
}

func checkExport(dir, purpose string, kind Kind, export Export, cpu bool, sizes map[string]int64) error {
	err := checkModelID(purpose, export.Model)
	if err != nil {
		return err
	}

	suffixes := dtypeSuffixes()

	suffix, ok := suffixes[export.Dtype]
	if !ok {
		return fmt.Errorf("%s dtype %q %w: %s", purpose, export.Dtype, errModelsDtype, strings.Join(slices.Sorted(maps.Keys(suffixes)), ", "))
	}

	what := fmt.Sprintf("%s %q", purpose, export.Model)
	root := filepath.Join(dir, filepath.FromSlash(export.Model))

	metadata, err := metadataSize(root, what)
	if err != nil {
		return err
	}

	onnx, err := exportBytes(root, exportFiles(kind, suffix), what)
	if err != nil {
		return err
	}

	sizes[exportKey(export.Model, export.Dtype)] = metadata + onnx

	if cpu && export.Dtype != cpuDtype {
		_, err = exportBytes(root, exportFiles(kind, suffixes[cpuDtype]), what+" on the CPU")
		if err != nil {
			return err
		}
	}

	for _, dtype := range slices.Sorted(maps.Keys(suffixes)) {
		onnx, err = exportBytes(root, exportFiles(kind, suffixes[dtype]), what)
		if errors.Is(err, errModelsMissing) || errors.Is(err, errModelsTooLarge) {
			continue
		}

		if err != nil {
			return err
		}

		sizes[exportKey(export.Model, dtype)] = metadata + onnx
	}

	return nil
}

func exportKey(model, dtype string) string {
	return model + ":" + dtype
}

func exportBytes(root string, names []string, what string) (int64, error) {
	var size int64

	for _, name := range names {
		bytes, err := exportSize(root, name, what)
		if err != nil {
			return 0, err
		}

		size += bytes
	}

	return size, nil
}

func checkModelID(purpose, model string) error {
	parts := strings.Split(model, "/")
	if len(parts) != modelIDParts || strings.ContainsAny(model, " :\t") {
		return fmt.Errorf("%s %q %w", purpose, model, errModelsDir)
	}

	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("%s %q %w", purpose, model, errModelsDir)
		}
	}

	return nil
}

func metadataSize(root, what string) (int64, error) {
	size, err := fileSize(filepath.Join(root, modelConfig), what)
	if err != nil {
		return 0, err
	}

	entries, err := os.ReadDir(root)
	if err != nil {
		return 0, fmt.Errorf("%s: %w", what, err)
	}

	for _, entry := range entries {
		if entry.Name() == modelConfig || path.Ext(entry.Name()) != ".json" || !entry.Type().IsRegular() {
			continue
		}

		bytes, err := fileSize(filepath.Join(root, entry.Name()), what)
		if err != nil {
			return 0, err
		}

		size += bytes
	}

	return size, nil
}

func exportSize(root, name, what string) (int64, error) {
	file := filepath.Join(root, filepath.FromSlash(name))

	size, err := fileSize(file, what)
	if err != nil {
		return 0, err
	}

	data, err := fileSize(file+externalData, what)
	if errors.Is(err, errModelsMissing) {
		return size, nil
	}

	if err != nil {
		return 0, err
	}

	return size + data, nil
}

func checkVoices(dir string, voices map[string]string, available languages, sizes map[string]int64) error {
	for _, code := range slices.Sorted(maps.Keys(voices)) {
		if _, ok := available.get(code); !ok {
			return fmt.Errorf("tts %q %w", code, errModelsLanguage)
		}

		voice := voices[code]
		if voice == "" || strings.ContainsAny(voice, `/\ :`) || strings.HasPrefix(voice, ".") {
			return fmt.Errorf("tts %q %q %w", code, voice, errVoiceName)
		}

		what := fmt.Sprintf("tts %q voice %q", code, voice)

		var size int64

		for _, suffix := range []string{voiceModel, voiceJSON} {
			bytes, err := fileSize(filepath.Join(dir, piperDir, voice+suffix), what)
			if err != nil {
				return err
			}

			size += bytes
		}

		sizes[piperDir+"/"+voice] = size
	}

	return nil
}

func fileSize(file, what string) (int64, error) {
	info, err := os.Stat(file)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrInvalid) {
			return 0, fmt.Errorf("%s %w: %s", what, errModelsMissing, file)
		}

		return 0, fmt.Errorf("%s: %w: %s", what, err, file)
	}

	if !info.Mode().IsRegular() {
		return 0, fmt.Errorf("%s %w: %s", what, errModelsMissing, file)
	}

	if info.Size() > maxBrowserFile {
		return 0, fmt.Errorf("%s %w, %d bytes against %d: %s", what, errModelsTooLarge, info.Size(), maxBrowserFile, file)
	}

	return info.Size(), nil
}

// newModelFiles serves the model directory the browsers load from. A
// model never changes under the same path, so a browser that has one
// keeps it.
func newModelFiles(dir string) http.Handler {
	files := http.StripPrefix(ModelsPath, http.FileServerFS(os.DirFS(dir)))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)

			return
		}

		// A directory is not a model file, and listing one serves nobody.
		if strings.HasSuffix(r.URL.Path, "/") {
			http.NotFound(w, r)

			return
		}

		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		files.ServeHTTP(w, r)
	})
}
