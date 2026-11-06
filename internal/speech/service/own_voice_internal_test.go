package service

import (
	"context"
	"encoding/base64"
	"slices"
	"sync"
	"testing"

	"github.com/stubbe/conference/internal/speech/vad"
	"github.com/stubbe/conference/internal/speech/wire"
)

const envCloning = "VOICE_CLONING"

// recordingVoice is a voice engine that remembers whether each request
// carried an own-voice reference, and can fail the cloned ones.
type recordingVoice struct {
	stubEngines

	failCloned bool
	mu         sync.Mutex
	calls      []bool
}

func (r *recordingVoice) speak(_ context.Context, _ string, _ language, _ voiceChoice, own *reference) (speech, error) {
	r.mu.Lock()
	r.calls = append(r.calls, own != nil)
	r.mu.Unlock()

	if own != nil && r.failCloned {
		return speech{}, errEngineDown
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
		failCloned: true, mu: sync.Mutex{}, calls: nil,
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
		failCloned: false, mu: sync.Mutex{}, calls: nil,
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
	own := &reference{wav: []byte("RIFFwave"), text: "hej du"}

	_, err := newHTTPEngines(settings).speak(t.Context(), "hallo welt", mustLanguage(t, settings, "de"), voiceOwn, own)
	if err != nil {
		t.Fatalf("speak: %v", err)
	}

	got := seen.speech
	if got.Voice != "" || got.VoiceRef == nil || got.VoiceRef.Type != "base64" ||
		got.VoiceRef.Data != base64.StdEncoding.EncodeToString(own.wav) || got.ReferenceText != "hej du" || got.Language != "de" {
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
