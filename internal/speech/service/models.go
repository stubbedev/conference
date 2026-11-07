package service

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
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

	// piperDir holds the voices under the model directory, each a model
	// file and the JSON beside it.
	piperDir    = "piper"
	modelConfig = "config.json"
	voiceModel  = ".onnx"
	voiceJSON   = ".onnx.json"

	modelIDParts = 2
)

var (
	errModelsJSON     = errors.New("is not valid JSON")
	errModelsMissing  = errors.New("is missing")
	errModelsDir      = errors.New("must be an owner and a name, e.g. onnx-community/whisper-large-v3-turbo")
	errModelsDtype    = errors.New("is not an export transformers.js loads: " + dtypes)
	errModelsLanguage = errors.New("is not one of the languages live translation has")
	errVoiceName      = errors.New("must be a voice's name, letters, digits, dashes and dots")
)

// dtypes are the ONNX exports transformers.js names, and the only ones a
// model directory can hold.
const dtypes = "fp32, fp16, q8, int8, uint8, q4, q4f16, bnb4, q2, q2f16, q1, q1f16"

// Models is what the browsers load: a model for transcription and one for
// translation, each with the languages that load one of their own, and a
// voice for every language it can speak.
type Models struct {
	ASR ModelChoice `json:"asr"`
	MT  ModelChoice `json:"mt"`

	// Voices is the voice each language speaks in, named as Piper names
	// them, e.g. da_DK-talesyntese-medium.
	Voices map[string]string `json:"voices"`

	// Base is the path the files are served from, empty when the browsers
	// run stand-in engines; problem says why they cannot load at all.
	Base    string `json:"base"`
	problem string
}

// ModelChoice is one purpose's model and the export it loads.
type ModelChoice struct {
	Model     string            `json:"model"`
	Dtype     string            `json:"dtype"`
	Languages map[string]string `json:"languages,omitempty"`
}

// modelFile is the shape of SPEECH_MODELS_FILE.
type modelFile struct {
	ASR ModelChoice       `json:"asr"`
	MT  ModelChoice       `json:"mt"`
	TTS map[string]string `json:"tts"`
}

// noModels is a model set that cannot load, and why; empty when the
// browsers run stand-in engines and load nothing.
func noModels(problem string) Models {
	return Models{
		ASR:     ModelChoice{Model: "", Dtype: "", Languages: nil},
		MT:      ModelChoice{Model: "", Dtype: "", Languages: nil},
		Voices:  nil,
		Base:    "",
		problem: problem,
	}
}

// loadModels reads the model choices from modelsFile and checks that
// every file they name is in dir, which the server serves. Stand-in
// engines need no files at all. A directory that cannot load is not an
// error here: it is why live translation is unavailable, which the app
// reports to whoever runs the server.
func (env environment) loadModels(dir, modelsFile string, available languages) Models {
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

	choices := []struct {
		purpose string
		choice  ModelChoice
	}{
		{purpose: "asr", choice: file.ASR},
		{purpose: "mt", choice: file.MT},
	}

	for _, entry := range choices {
		err = checkChoice(dir, entry.purpose, entry.choice, available)
		if err != nil {
			return noModels(fmt.Sprintf("%s: %v", envModelsFile, err))
		}
	}

	err = checkVoices(dir, file.TTS, available)
	if err != nil {
		return noModels(fmt.Sprintf("%s: %v", envModelsFile, err))
	}

	return Models{ASR: file.ASR, MT: file.MT, Voices: file.TTS, Base: ModelsPath, problem: ""}
}

// readModelFile reads the model choices, which have no defaults: every
// purpose loads a model somebody put in the model directory.
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

// checkChoice validates one purpose's model and confirms that its files
// are in dir, along with those of every language with a model of its own.
func checkChoice(dir, purpose string, choice ModelChoice, available languages) error {
	err := checkModel(dir, purpose, choice.Model)
	if err != nil {
		return err
	}

	if !slices.Contains(strings.Split(dtypes, ", "), choice.Dtype) {
		return fmt.Errorf("%s dtype %q %w", purpose, choice.Dtype, errModelsDtype)
	}

	for _, code := range sortedKeys(choice.Languages) {
		if _, ok := available.get(code); !ok {
			return fmt.Errorf("%s %q %w", purpose, code, errModelsLanguage)
		}

		err = checkModel(dir, purpose+"."+code, choice.Languages[code])
		if err != nil {
			return err
		}
	}

	return nil
}

// checkModel confirms that a model id names a directory of files in dir,
// in the layout a browser loads a model from.
func checkModel(dir, purpose, model string) error {
	parts := strings.Split(model, "/")
	valid := len(parts) == modelIDParts && parts[0] != "" && parts[1] != "" && !strings.ContainsAny(model, " :\t")

	if !valid {
		return fmt.Errorf("%s %q %w", purpose, model, errModelsDir)
	}

	return checkFile(filepath.Join(dir, filepath.FromSlash(model), modelConfig), fmt.Sprintf("%s %q", purpose, model))
}

// checkVoices confirms that every language has a Piper voice in dir, the
// model and the JSON beside it.
func checkVoices(dir string, voices map[string]string, available languages) error {
	for _, code := range sortedKeys(voices) {
		if _, ok := available.get(code); !ok {
			return fmt.Errorf("tts %q %w", code, errModelsLanguage)
		}

		voice := voices[code]
		if voice == "" || strings.ContainsAny(voice, `/\ :`) {
			return fmt.Errorf("tts %q %q %w", code, voice, errVoiceName)
		}

		what := fmt.Sprintf("tts %q voice %q", code, voice)

		for _, suffix := range []string{voiceModel, voiceJSON} {
			err := checkFile(filepath.Join(dir, piperDir, voice+suffix), what)
			if err != nil {
				return err
			}
		}
	}

	return nil
}

// checkFile confirms that a file the browsers load is where they look for
// it, and names what loads it when it is not.
func checkFile(file, what string) error {
	info, err := os.Stat(file)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) || errors.Is(err, fs.ErrInvalid) {
			return fmt.Errorf("%s %w: %s", what, errModelsMissing, file)
		}

		return fmt.Errorf("%s: %w: %s", what, err, file)
	}

	if !info.Mode().IsRegular() {
		return fmt.Errorf("%s %w: %s", what, errModelsMissing, file)
	}

	return nil
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

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}

	slices.Sort(keys)

	return keys
}
