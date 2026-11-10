package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/stubbe/conference/internal/speech/vad"
	"github.com/stubbe/conference/internal/speech/wav"
)

const (
	engineTimeout     = 15 * time.Second
	maxResponseBytes  = 32 << 20
	fakeToneSeconds   = 0.4
	warmUpSamples     = vad.Rate / 2
	fakeToneHz        = 440
	fakeOwnToneHz     = 660
	fakeToneLevel     = 0.2
	noSpeechThreshold = 0.6
	logprobThreshold  = -1.0
)

type speech struct {
	pcm  []byte
	rate int
	// converting is how long a conversion engine took to make it the
	// speaker's own voice; zero otherwise.
	converting time.Duration
}

type speechEngines interface {
	transcribe(ctx context.Context, audio []int16, lang language) (string, error)
	translate(ctx context.Context, text string, source, target language, earlier []string) (string, error)
	speak(ctx context.Context, text string, lang language, choice voiceChoice, own *reference) (speech, error)
}

// reference is a speaker's own voice, for a cloning voice engine or a
// conversion engine: the WAV they recorded and its transcript.
type reference struct {
	wav  []byte
	text string
	// stock is the stock voice nearer the speaker's pitch: a conversion
	// starts from it, and a failed own voice falls back to it.
	stock voiceChoice
}

// stockFor is the stock voice to speak in instead of choice: the one
// nearer the speaker's pitch when there is a recording.
func (r *reference) stockFor(choice voiceChoice) voiceChoice {
	if r == nil {
		return choice
	}

	return r.stock
}

// voiceRef is how the voice engine takes a reference recording inline
// (audio.cpp's voice_ref), so nothing is stored there between requests.
type voiceRef struct {
	Type string `json:"type"`
	Data string `json:"data"`
}

func newHTTPEngines(settings Settings) *httpEngines {
	return &httpEngines{settings: settings, client: &http.Client{Timeout: engineTimeout}}
}

var (
	errStatus      = errors.New("unexpected status")
	errNoChoice    = errors.New("no choices in the reply")
	errNoVoiceName = errors.New("no voice name")
	errNoAudio     = errors.New("no audio in the reply")
)

// unconvertedError is a failed voice conversion that still has the
// stock voice it started from, so a listener needn't wait for it again.
type unconvertedError struct {
	stock speech
	err   error
}

func (e *unconvertedError) Error() string { return e.err.Error() }

func (e *unconvertedError) Unwrap() error { return e.err }

// convertRequest is audio.cpp's /tasks/run for a voice conversion model:
// the stock voice and the speaker's recording, both inline.
type convertRequest struct {
	Model   string      `json:"model"`
	Request convertTask `json:"request"`
}

type convertTask struct {
	Audio    string   `json:"audio_base64"` //nolint:tagliatelle // the conversion engine's wire format.
	VoiceRef voiceRef `json:"voice_ref"`    //nolint:tagliatelle // the conversion engine's wire format.
}

type convertReply struct {
	Audio string `json:"audio"`
}

type chatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type chatRequest struct {
	Model    string        `json:"model"`
	Messages []chatMessage `json:"messages"`
}

type chatReply struct {
	Choices []struct {
		Message chatMessage `json:"message"`
	} `json:"choices"`
}

type ollamaOptions struct {
	Temperature float64 `json:"temperature"`
}

type ollamaRequest struct {
	Model    string        `json:"model"`
	Stream   bool          `json:"stream"`
	Think    bool          `json:"think"`
	Options  ollamaOptions `json:"options"`
	Messages []chatMessage `json:"messages"`
}

type ollamaReply struct {
	Message chatMessage `json:"message"`
}

type speechRequest struct {
	Model          string    `json:"model"`
	Voice          string    `json:"voice,omitempty"`
	Input          string    `json:"input"`
	ResponseFormat string    `json:"response_format"`          //nolint:tagliatelle // OpenAI's wire format.
	VoiceRef       *voiceRef `json:"voice_ref,omitempty"`      //nolint:tagliatelle // the voice engine's wire format.
	ReferenceText  string    `json:"reference_text,omitempty"` //nolint:tagliatelle // the voice engine's wire format.
	Language       string    `json:"language,omitempty"`
}

type transcriptionSegment struct {
	Text         string  `json:"text"`
	NoSpeechProb float64 `json:"no_speech_prob"` //nolint:tagliatelle // OpenAI's wire format.
	AvgLogprob   float64 `json:"avg_logprob"`    //nolint:tagliatelle // OpenAI's wire format.
}

type transcriptionReply struct {
	Text     string                 `json:"text"`
	Segments []transcriptionSegment `json:"segments"`
}

func (r transcriptionReply) speech(format responseFormat) string {
	if format != formatVerbose {
		return strings.TrimSpace(r.Text)
	}

	kept := make([]string, 0, len(r.Segments))

	for _, segment := range r.Segments {
		if segment.NoSpeechProb > noSpeechThreshold && segment.AvgLogprob < logprobThreshold {
			continue
		}

		if text := strings.TrimSpace(segment.Text); text != "" {
			kept = append(kept, text)
		}
	}

	return strings.Join(kept, " ")
}

type httpEngines struct {
	settings Settings
	client   *http.Client
}

func (e *httpEngines) transcribe(ctx context.Context, audio []int16, lang language) (string, error) {
	format := e.settings.transcribeFormat

	body, contentType, err := transcriptionForm(audio, e.settings.transcription.model, lang.Whisper, format)
	if err != nil {
		return "", fmt.Errorf("%s: build the form: %w", transcription, err)
	}

	var reply transcriptionReply

	err = e.call(ctx, transcription, e.settings.transcription, "/audio/transcriptions", contentType, body, &reply)
	if err != nil {
		return "", err
	}

	return reply.speech(format), nil
}

func transcriptionForm(audio []int16, model, lang string, format responseFormat) (*bytes.Buffer, string, error) {
	encoded, err := wav.Encode(audio, vad.Rate)
	if err != nil {
		return nil, "", fmt.Errorf("encode audio: %w", err)
	}

	var body bytes.Buffer

	form := multipart.NewWriter(&body)

	part, err := form.CreateFormFile("file", "speech.wav")
	if err != nil {
		return nil, "", fmt.Errorf("add the audio: %w", err)
	}

	_, err = part.Write(encoded)
	if err != nil {
		return nil, "", fmt.Errorf("add the audio: %w", err)
	}

	for _, field := range [][2]string{{"model", model}, {"language", lang}, {"response_format", string(format)}} {
		err = form.WriteField(field[0], field[1])
		if err != nil {
			return nil, "", fmt.Errorf("add %s: %w", field[0], err)
		}
	}

	err = form.Close()
	if err != nil {
		return nil, "", fmt.Errorf("close the form: %w", err)
	}

	return &body, form.FormDataContentType(), nil
}

func (e *httpEngines) translate(ctx context.Context, text string, source, target language, earlier []string) (string, error) {
	messages := []chatMessage{
		{Role: "system", Content: e.settings.prompt.render(source, target, earlier)},
		{Role: "user", Content: text},
	}

	use := e.settings.translation
	if use.provider == openAICompatible {
		var reply chatReply

		err := e.callJSON(ctx, translation, use, "/chat/completions", chatRequest{Model: use.model, Messages: messages}, &reply)
		if err != nil {
			return "", err
		}

		if len(reply.Choices) == 0 {
			return "", fmt.Errorf("%s: %w", translation, errNoChoice)
		}

		return strings.TrimSpace(reply.Choices[0].Message.Content), nil
	}

	var reply ollamaReply

	err := e.callJSON(ctx, translation, use, "/api/chat", ollamaRequest{
		Model:    use.model,
		Stream:   false,
		Think:    false,
		Options:  ollamaOptions{Temperature: 0},
		Messages: messages,
	}, &reply)
	if err != nil {
		return "", err
	}

	return strings.TrimSpace(reply.Message.Content), nil
}

func (e *httpEngines) speak(ctx context.Context, text string, lang language, choice voiceChoice, own *reference) (speech, error) {
	request := speechRequest{
		Model: e.settings.voice.model, Voice: "", Input: text, ResponseFormat: "wav",
		VoiceRef: nil, ReferenceText: "", Language: "",
	}

	if own != nil && e.settings.voiceCloning {
		request.VoiceRef = &voiceRef{Type: "base64", Data: base64.StdEncoding.EncodeToString(own.wav)}
		request.ReferenceText = own.text
		request.Language = lang.Code
	} else {
		name, err := e.stockVoice(lang, own.stockFor(choice))
		if err != nil {
			return speech{}, err
		}

		request.Voice = name
	}

	payload, err := json.Marshal(request)
	if err != nil {
		return speech{}, fmt.Errorf("%s: encode the request: %w", voice, err)
	}

	var reply bytes.Buffer

	err = e.call(ctx, voice, e.settings.voice, "/audio/speech", "application/json", bytes.NewReader(payload), &reply)
	if err != nil {
		return speech{}, err
	}

	samples, rate, err := wav.Decode(reply.Bytes())
	if err != nil {
		return speech{}, fmt.Errorf("%s: read the voice: %w", voice, err)
	}

	spoken, err := pcmSpeech(voice, samples, rate)
	if err != nil || own == nil || e.settings.conversion == nil {
		return spoken, err
	}

	return e.converted(ctx, samples, rate, spoken, own)
}

// converted is the stock voice in the speaker's own voice, or, if that
// fails, an unconvertedError that carries the stock voice.
func (e *httpEngines) converted(ctx context.Context, samples []int16, rate uint32, spoken speech, own *reference) (speech, error) {
	// A streaming voice engine's WAV has no real sizes in its header, which
	// a conversion engine may refuse, so it gets a WAV written afresh.
	stock, err := wav.Encode(samples, rate)
	if err != nil {
		return speech{}, &unconvertedError{stock: spoken, err: fmt.Errorf("%s: encode the voice: %w", conversion, err)}
	}

	started := time.Now()

	converted, err := e.convert(ctx, stock, own)
	if err != nil {
		return speech{}, &unconvertedError{stock: spoken, err: err}
	}

	converted.converting = time.Since(started)

	return converted, nil
}

// voiceWarmer is a voice engine that can get a speaker's own voice ready
// before their first sentence.
type voiceWarmer interface {
	warmVoice(ctx context.Context, own *reference) error
}

// warmVoice has the conversion engine load its model and prepare the
// speaker's voice with a short silence, so the first sentence in their
// voice doesn't wait for either.
func (e *httpEngines) warmVoice(ctx context.Context, own *reference) error {
	if e.settings.conversion == nil {
		return nil
	}

	silence, err := wav.Encode(make([]int16, warmUpSamples), vad.Rate)
	if err != nil {
		return fmt.Errorf("%s: encode the warm-up: %w", conversion, err)
	}

	_, err = e.convert(ctx, silence, own)

	return err
}

// convert turns a stock voice WAV into the speaker's own voice.
func (e *httpEngines) convert(ctx context.Context, stock []byte, own *reference) (speech, error) {
	request := convertRequest{
		Model: e.settings.conversion.model,
		Request: convertTask{
			Audio:    base64.StdEncoding.EncodeToString(stock),
			VoiceRef: voiceRef{Type: "base64", Data: base64.StdEncoding.EncodeToString(own.wav)},
		},
	}

	var reply convertReply

	err := e.callJSON(ctx, conversion, *e.settings.conversion, "/tasks/run", request, &reply)
	if err != nil {
		return speech{}, err
	}

	if reply.Audio == "" {
		return speech{}, fmt.Errorf("%s: %w", conversion, errNoAudio)
	}

	converted, err := base64.StdEncoding.DecodeString(reply.Audio)
	if err != nil {
		return speech{}, fmt.Errorf("%s: read the audio: %w", conversion, err)
	}

	return decodeSpeech(conversion, converted)
}

func decodeSpeech(use purpose, data []byte) (speech, error) {
	samples, rate, err := wav.Decode(data)
	if err != nil {
		return speech{}, fmt.Errorf("%s: read the voice: %w", use, err)
	}

	return pcmSpeech(use, samples, rate)
}

func pcmSpeech(use purpose, samples []int16, rate uint32) (speech, error) {
	pcm, err := binary.Append(make([]byte, 0, len(samples)*pcmWidth), binary.LittleEndian, samples)
	if err != nil {
		return speech{}, fmt.Errorf("%s: encode the voice: %w", use, err)
	}

	return speech{pcm: pcm, rate: int(rate), converting: 0}, nil
}

func (e *httpEngines) stockVoice(lang language, choice voiceChoice) (string, error) {
	name := lang.Voices[choice.stock()]
	if name == "" {
		name = lang.Voices[defaultVoice]
	}

	if name == "" {
		name = e.settings.voiceName
	}

	if name == "" {
		return "", fmt.Errorf("%s: %w for %s", voice, errNoVoiceName, lang.Code)
	}

	return name, nil
}

func (e *httpEngines) callJSON(ctx context.Context, use purpose, target engine, path string, request, reply any) error {
	payload, err := json.Marshal(request)
	if err != nil {
		return fmt.Errorf("%s: encode the request: %w", use, err)
	}

	return e.call(ctx, use, target, path, "application/json", bytes.NewReader(payload), reply)
}

func (e *httpEngines) call(ctx context.Context, use purpose, target engine, path, contentType string, body io.Reader, reply any) error {
	address := target.endpoint.JoinPath(path)
	endpoint := address.Redacted()

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, address.String(), body)
	if err != nil {
		return fmt.Errorf("%s: build the request to %s: %w", use, endpoint, err)
	}

	request.Header.Set("Content-Type", contentType)

	if target.apiKey != "" {
		request.Header.Set("Authorization", "Bearer "+target.apiKey)
	}

	response, err := e.client.Do(request)
	if err != nil {
		return fmt.Errorf("%s: %w", use, err)
	}

	defer func() { _ = response.Body.Close() }()

	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: %w %d from %s", use, errStatus, response.StatusCode, endpoint)
	}

	limited := io.LimitReader(response.Body, maxResponseBytes)

	if raw, ok := reply.(*bytes.Buffer); ok {
		_, err = raw.ReadFrom(limited)
		if err != nil {
			return fmt.Errorf("%s: read the reply from %s: %w", use, endpoint, err)
		}

		return nil
	}

	err = json.NewDecoder(limited).Decode(reply)
	if err != nil {
		return fmt.Errorf("%s: decode the reply from %s: %w", use, endpoint, err)
	}

	return nil
}

type fakeEngines struct {
	utterances atomic.Int64
}

func (f *fakeEngines) transcribe(_ context.Context, _ []int16, lang language) (string, error) {
	return fmt.Sprintf("%s utterance %d", lang.Code, f.utterances.Add(1)), nil
}

func (f *fakeEngines) translate(_ context.Context, text string, _, target language, _ []string) (string, error) {
	return fmt.Sprintf("[%s] %s", target.Code, text), nil
}

// speak is a tone: a higher one in a speaker's own voice, so a test can
// tell the two apart.
func (f *fakeEngines) speak(_ context.Context, _ string, _ language, _ voiceChoice, own *reference) (speech, error) {
	frequency := float64(fakeToneHz)
	if own != nil {
		frequency = float64(fakeOwnToneHz)
	}

	tone := make([]int16, int(fakeToneSeconds*vad.Rate))
	for i := range tone {
		tone[i] = int16(fakeToneLevel * math.MaxInt16 * math.Sin(2*math.Pi*frequency*float64(i)/vad.Rate))
	}

	pcm, err := binary.Append(nil, binary.LittleEndian, tone)
	if err != nil {
		return speech{}, fmt.Errorf("fake voice: %w", err)
	}

	return speech{pcm: pcm, rate: vad.Rate, converting: 0}, nil
}
