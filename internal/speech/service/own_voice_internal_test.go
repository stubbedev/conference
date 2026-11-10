package service

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"slices"
	"sync"
	"testing"

	"github.com/stubbe/conference/internal/speech/vad"
	"github.com/stubbe/conference/internal/speech/wav"
	"github.com/stubbe/conference/internal/speech/wire"
)

const (
	envCloning   = "VOICE_CLONING"
	modelConvert = "chatterbox-vc"
	sampleText   = "hej du"
)

// recordingVoice is a voice engine that remembers whether each request
// carried an own-voice reference, and can fail the cloned ones.
type recordingVoice struct {
	stubEngines

	failCloned bool
	// unconverted fails own-voice requests the way a failed conversion does.
	unconverted bool
	mu          sync.Mutex
	calls       []bool
}

func (r *recordingVoice) speak(_ context.Context, _ string, _ language, _ voiceChoice, own *reference) (speech, error) {
	r.mu.Lock()
	r.calls = append(r.calls, own != nil)
	r.mu.Unlock()

	if own != nil && r.failCloned {
		return speech{}, errEngineDown
	}

	if own != nil && r.unconverted {
		return speech{}, &unconvertedError{stock: speech{pcm: []byte{0, 0}, rate: vad.Rate}, err: errEngineDown}
	}

	return speech{pcm: []byte{0, 0}, rate: vad.Rate}, nil
}

func (r *recordingVoice) seen() []bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	return slices.Clone(r.calls)
}

func newOwnVoiceSession(t *testing.T, cloning string, engines speechEngines) (*session, *outbox) {
	t.Helper()

	out := newOutbox()

	opened, err := newSession(t.Context(), load(t, map[string]string{envEngines: enginesFake, envCloning: cloning}), engines, anna, out.send)
	if err != nil {
		t.Fatalf("session: %v", err)
	}

	t.Cleanup(opened.close)
	opened.setTargets([]string{"de", "en"})

	return opened, out
}

// sentence is a finished German sentence of this many seconds.
func sentence(t *testing.T, opened *session, choice voiceChoice, seconds int) final {
	t.Helper()

	return final{
		seg:   0,
		lang:  mustLanguage(t, opened.settings, "de"),
		voice: choice,
		audio: make([]int16, seconds*vad.Rate),
		own:   nil,
	}
}

func TestOwnVoiceOnlyWhenChosen(t *testing.T) {
	t.Parallel()

	opened, out := newOwnVoiceSession(t, "true", stubEngines{transcribeFn: echoTranscripts, translateFn: echoTranslations})
	sendSample(t, opened, 8)
	out.waitFor(t, noticeOf(wire.NoticeOwnVoiceReady))

	if own := opened.ownVoice(opened.speaker, sentence(t, opened, voiceMale, 1)); own != nil {
		t.Fatal("spoke in the recorded voice for a speaker who chose a stock voice")
	}

	without, _ := newOwnVoiceSession(t, "", stubEngines{transcribeFn: echoTranscripts, translateFn: echoTranslations})
	if own := without.ownVoice(without.speaker, sentence(t, without, voiceOwn, 1)); own != nil {
		t.Fatal("an own voice without VOICE_CLONING")
	}

	if own := opened.ownVoice(opened.speaker, sentence(t, opened, voiceOwn, 10)); own == nil {
		t.Fatal("no own voice after the sample was ready")
	}
}

func TestOwnVoiceFallsBackToTheStockVoice(t *testing.T) {
	t.Parallel()

	engines := &recordingVoice{
		transcribeFn: echoTranscripts, translateFn: echoTranslations,
		failCloned: true, unconverted: false, mu: sync.Mutex{}, calls: nil,
	}
	opened, out := newOwnVoiceSession(t, "true", engines)

	job := sentence(t, opened, voiceOwn, 1)
	job.own = &reference{wav: []byte("RIFF"), text: "hallo"}

	opened.translate(t.Context(), opened.speaker, job, mustLanguage(t, opened.settings, "en"), "hallo", nil)

	if got := engines.seen(); !slices.Equal(got, []bool{true, false}) {
		t.Fatalf("voice calls %v, want the cloned one then the stock one", got)
	}

	out.waitFor(t, func(message any) bool {
		frame, ok := message.(voiceFrame)

		return ok && !frame.header.Cloned
	})
}

func TestVoiceOnlyWhereSomeoneListens(t *testing.T) {
	t.Parallel()

	engines := &recordingVoice{
		transcribeFn: echoTranscripts, translateFn: echoTranslations,
		failCloned: false, unconverted: false, mu: sync.Mutex{}, calls: nil,
	}
	opened, out := newOwnVoiceSession(t, "", engines)
	opened.setVoiceTargets([]string{})

	english := mustLanguage(t, opened.settings, "en")
	opened.translate(t.Context(), opened.speaker, sentence(t, opened, voiceFemale, 1), english, "hallo", nil)

	out.waitFor(t, finalCaption("en"))

	if calls := engines.seen(); len(calls) != 0 {
		t.Fatalf("spoke %d times with nobody listening to a voice", len(calls))
	}

	opened.setVoiceTargets(nil)
	opened.translate(t.Context(), opened.speaker, sentence(t, opened, voiceFemale, 1), english, "hallo", nil)

	if calls := engines.seen(); len(calls) != 1 {
		t.Fatalf("without voiceTargets every target is spoken; got %d calls", len(calls))
	}
}

func TestOwnVoiceRequest(t *testing.T) {
	t.Parallel()

	api, seen := fakeAPI(t)
	settings := openAISettings(t, api)
	settings.voiceCloning = true
	own := &reference{wav: []byte("RIFFwave"), text: sampleText}

	_, err := newHTTPEngines(settings).speak(t.Context(), "hallo welt", mustLanguage(t, settings, "de"), voiceOwn, own)
	if err != nil {
		t.Fatalf("speak: %v", err)
	}

	got := seen.speech
	if got.Voice != "" || got.VoiceRef == nil || got.VoiceRef.Type != "base64" ||
		got.VoiceRef.Data != base64.StdEncoding.EncodeToString(own.wav) || got.ReferenceText != sampleText || got.Language != "de" {
		t.Fatalf("own-voice request %+v (ref %+v)", got, got.VoiceRef)
	}
}

func TestOwnVoiceStatus(t *testing.T) {
	t.Parallel()

	if status := load(t, map[string]string{envEngines: enginesFake}).Status(); status.OwnVoice {
		t.Fatalf("without cloning: %+v", status)
	}

	cloning := load(t, map[string]string{envEngines: enginesFake, envCloning: "true"})
	if status := cloning.Status(); !status.OwnVoice {
		t.Fatalf("with cloning: %+v", status)
	}

	_, err := FromEnv(func(name string) string { return map[string]string{envCloning: "maybe"}[name] })
	if err == nil {
		t.Fatal("VOICE_CLONING=maybe was accepted")
	}
}

// sendSample sends a recorded Swedish voice sample of this many seconds.
func sendSample(t *testing.T, opened *session, seconds int) {
	t.Helper()

	const lang = "sv"

	header := wire.AudioHeader{Speaker: anna, Lang: lang, Voice: string(voiceOwn), Sample: true}
	audio := make([]int16, seconds*vad.Rate)

	for offset := 0; offset < len(audio); offset += chunk {
		err := opened.sampleAudio(header, audio[offset:min(offset+chunk, len(audio))])
		if err != nil {
			t.Fatalf("sample audio: %v", err)
		}
	}

	err := opened.finishSample(t.Context(), anna, lang)
	if err != nil {
		t.Fatalf("finish the sample: %v", err)
	}
}

func noticeOf(code string) func(any) bool {
	return func(message any) bool {
		notice, ok := message.(wire.Notice)

		return ok && notice.Code == code
	}
}

func TestRecordedVoiceIsUsedFromTheFirstSentence(t *testing.T) {
	t.Parallel()

	opened, out := newOwnVoiceSession(t, "true", stubEngines{transcribeFn: echoTranscripts, translateFn: echoTranslations})

	sendSample(t, opened, 8)
	out.waitFor(t, noticeOf(wire.NoticeOwnVoiceReady))

	own := opened.ownVoice(opened.speaker, sentence(t, opened, voiceOwn, 1))
	if own == nil || own.text != "said in sv" {
		t.Fatalf("first sentence spoke with %+v, want the recorded sample and its transcript", own)
	}
}

func TestRecordedVoiceTooShortOrSilent(t *testing.T) {
	t.Parallel()

	short, out := newOwnVoiceSession(t, "true", stubEngines{transcribeFn: echoTranscripts, translateFn: echoTranslations})
	sendSample(t, short, 3)
	out.waitFor(t, noticeOf(wire.NoticeOwnVoiceRejected))

	silent, quiet := newOwnVoiceSession(t, "true", stubEngines{
		transcribeFn: func(context.Context, language) (string, error) { return "", nil },
		translateFn:  echoTranslations,
	})
	sendSample(t, silent, 8)
	quiet.waitFor(t, noticeOf(wire.NoticeOwnVoiceRejected))

	for _, opened := range []*session{short, silent} {
		if opened.speaker.prepared.Load() != nil {
			t.Fatal("a rejected sample was kept")
		}
	}
}

func TestRecordedVoiceNeedsCloningAndItsOwnSpeaker(t *testing.T) {
	t.Parallel()

	without, out := newOwnVoiceSession(t, "", stubEngines{transcribeFn: echoTranscripts, translateFn: echoTranslations})
	sendSample(t, without, 8)

	if without.speaker.prepared.Load() != nil || len(out.snapshot()) != 0 || without.speaker.incoming != nil {
		t.Fatalf("kept or answered a sample without VOICE_CLONING: %+v", out.snapshot())
	}

	opened, _ := newOwnVoiceSession(t, "true", stubEngines{transcribeFn: echoTranscripts, translateFn: echoTranslations})

	err := opened.sampleAudio(wire.AudioHeader{Speaker: sam, Lang: "sv", Voice: string(voiceOwn), Sample: true}, make([]int16, chunk))
	if err == nil {
		t.Fatal("accepted sample audio for another member")
	}

	err = opened.finishSample(t.Context(), sam, "sv")
	if err == nil {
		t.Fatal("accepted another member's voice sample")
	}
}

func TestForgetVoiceDropsEverything(t *testing.T) {
	t.Parallel()

	opened, out := newOwnVoiceSession(t, "true", stubEngines{transcribeFn: echoTranscripts, translateFn: echoTranslations})

	sendSample(t, opened, 8)
	out.waitFor(t, noticeOf(wire.NoticeOwnVoiceReady))

	err := opened.forgetVoice(anna)
	if err != nil {
		t.Fatalf("forget: %v", err)
	}

	if opened.speaker.prepared.Load() != nil || opened.speaker.incoming != nil {
		t.Fatal("the voice survived forget-voice")
	}

	if own := opened.ownVoice(opened.speaker, sentence(t, opened, voiceOwn, 1)); own != nil {
		t.Fatal("still spoke in the forgotten voice")
	}

	err = opened.forgetVoice(sam)
	if err == nil {
		t.Fatal("another member made this speaker's voice be forgotten")
	}
}

func convertingSettings(t *testing.T, api *httptest.Server, convertURL string) Settings {
	t.Helper()

	settings := openAISettings(t, api)
	settings.conversion = &engine{
		provider: audioCPP, endpoint: mustURL(t, convertURL), apiKey: "", model: modelConvert, problem: "", external: false,
	}

	return settings
}

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()

	parsed, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}

	return parsed
}

func TestConvertedVoiceRequests(t *testing.T) {
	t.Parallel()

	api, seen := fakeAPI(t)
	settings := convertingSettings(t, api, api.URL+"/v1")
	own := &reference{wav: []byte("RIFFwave"), text: sampleText}

	spoken, err := newHTTPEngines(settings).speak(t.Context(), helloGerman, mustLanguage(t, settings, "de"), voiceOwn, own)
	if err != nil {
		t.Fatalf("speak: %v", err)
	}

	if spoken.rate != convertTestRate || len(spoken.pcm) != 6 {
		t.Fatalf("spoke %d bytes at %d Hz, want the converted voice", len(spoken.pcm), spoken.rate)
	}

	if got := seen.speech; got.Voice != voiceAlloy || got.VoiceRef != nil || got.ReferenceText != "" {
		t.Fatalf("the stock voice request carried the speaker's voice: %+v", got)
	}

	checkConvertRequest(t, seen.convert, own)
}

// checkConvertRequest checks that the stock voice the fake API spoke and
// the speaker's recording went to the conversion engine.
func checkConvertRequest(t *testing.T, got convertRequest, own *reference) {
	t.Helper()

	stock, err := wav.Encode([]int16{1, 2}, voiceTestRate)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	if got.Model != modelConvert || got.Request.Audio != base64.StdEncoding.EncodeToString(stock) ||
		got.Request.VoiceRef != (voiceRef{Type: "base64", Data: base64.StdEncoding.EncodeToString(own.wav)}) {
		t.Fatalf("conversion request %+v", got)
	}
}

func TestFailedConversionKeepsTheStockVoice(t *testing.T) {
	t.Parallel()

	api, _ := fakeAPI(t)
	down := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(down.Close)

	settings := convertingSettings(t, api, down.URL)

	_, err := newHTTPEngines(settings).speak(t.Context(), helloGerman, mustLanguage(t, settings, "de"), voiceOwn,
		&reference{wav: []byte("RIFF"), text: "hej"})

	unconverted, ok := errors.AsType[*unconvertedError](err)
	if !ok || unconverted.stock.rate != voiceTestRate {
		t.Fatalf("a failed conversion returned %v, want the stock voice with the error", err)
	}

	engines := &recordingVoice{
		transcribeFn: echoTranscripts, translateFn: echoTranslations,
		failCloned: false, unconverted: true, mu: sync.Mutex{}, calls: nil,
	}
	opened, out := newOwnVoiceSession(t, "true", engines)

	job := sentence(t, opened, voiceOwn, 1)
	job.own = &reference{wav: []byte("RIFF"), text: "hallo"}

	opened.translate(t.Context(), opened.speaker, job, mustLanguage(t, opened.settings, "en"), "hallo", nil)

	if got := engines.seen(); !slices.Equal(got, []bool{true}) {
		t.Fatalf("voice calls %v, want only the one whose conversion failed", got)
	}

	out.waitFor(t, func(message any) bool {
		frame, ok := message.(voiceFrame)

		return ok && !frame.header.Cloned
	})
}

func TestConversionSettings(t *testing.T) {
	t.Parallel()

	converting := load(t, map[string]string{
		envConvertURL: "http://voice.lan:8099/v1", envConvertModel: modelConvert,
	})
	if !converting.Status().OwnVoice || converting.conversion == nil {
		t.Fatalf("with a conversion engine: %+v", converting.Status())
	}

	external := load(t, map[string]string{
		envConvertURL: "https://voices.example.com/v1", envConvertModel: "vc",
	})
	if !external.Status().External {
		t.Fatal("an external conversion engine was not reported as external")
	}

	for name, values := range map[string]map[string]string{
		"address only": {envConvertURL: "http://voice.lan/v1"},
		"model only":   {envConvertModel: "vc"},
		"and cloning":  {envConvertURL: "http://voice.lan/v1", envConvertModel: "vc", envCloning: "true"},
	} {
		_, err := FromEnv(func(key string) string { return values[key] })
		if err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

// streamedWAV is a WAV as a streaming voice engine sends it: the RIFF and
// data sizes are unknown when the header goes out, so both are 0xFFFFFFFF.
func streamedWAV(t *testing.T, samples []int16, rate uint32) []byte {
	t.Helper()

	data, err := wav.Encode(samples, rate)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	const riffSize, dataSize = 4, 40

	for _, at := range []int{riffSize, dataSize} {
		binary.LittleEndian.PutUint32(data[at:], math.MaxUint32)
	}

	return data
}

func TestConversionGetsAWellFormedWAV(t *testing.T) {
	t.Parallel()

	stock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(streamedWAV(t, []int16{1, 2, 3}, voiceTestRate))
	}))
	t.Cleanup(stock.Close)

	var sent []byte

	converter := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request convertRequest

		decodeInto(t, r, &request)

		sent, _ = base64.StdEncoding.DecodeString(request.Request.Audio)

		converted, err := wav.Encode([]int16{4}, convertTestRate)
		if err != nil {
			t.Errorf("encode: %v", err)
		}

		_, _ = io.WriteString(w, `{"audio":"`+base64.StdEncoding.EncodeToString(converted)+`"}`)
	}))
	t.Cleanup(converter.Close)

	settings := convertingSettings(t, stock, converter.URL+"/v1")
	settings.voice.endpoint = mustURL(t, stock.URL)

	_, err := newHTTPEngines(settings).speak(t.Context(), helloGerman, mustLanguage(t, settings, "de"), voiceOwn,
		&reference{wav: []byte("RIFF"), text: sampleText})
	if err != nil {
		t.Fatalf("speak: %v", err)
	}

	want, err := wav.Encode([]int16{1, 2, 3}, voiceTestRate)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}

	if !bytes.Equal(sent, want) {
		t.Fatalf("the converter got % x, want a WAV with its real sizes % x", sent, want)
	}
}
