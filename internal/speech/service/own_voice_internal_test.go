package service

import (
	"context"
	"encoding/base64"
	"slices"
	"sync"
	"testing"

	"github.com/stubbe/conference/internal/speech/vad"
	"github.com/stubbe/conference/internal/speech/wav"
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

func sentence(t *testing.T, opened *session, lang string, choice voiceChoice, seconds int) final {
	t.Helper()

	return final{
		seg:   0,
		lang:  mustLanguage(t, opened.settings, lang),
		voice: choice,
		audio: make([]int16, seconds*vad.Rate),
		own:   nil,
	}
}

func notices(out *outbox, code string) []wire.Notice {
	var found []wire.Notice

	for _, message := range out.snapshot() {
		if notice, ok := message.(wire.Notice); ok && notice.Code == code {
			found = append(found, notice)
		}
	}

	return found
}

func TestOwnVoiceReportsItsProgress(t *testing.T) {
	t.Parallel()

	opened, out := newOwnVoiceSession(t, "true", stubEngines{transcribeFn: echoTranscripts, translateFn: echoTranslations})

	for _, length := range []int{5, 5} {
		if own := opened.learn(t.Context(), opened.speaker, sentence(t, opened, "de", voiceOwn, length), "eins"); own != nil {
			t.Fatalf("ready after %d s too early", length)
		}
	}

	learning := notices(out, wire.NoticeOwnVoiceLearning)
	if len(learning) != 2 || learning[0].Seconds != 5 || learning[1].Seconds != 10 {
		t.Fatalf("learning notices %+v, want 5 s then 10 s", learning)
	}
}

func TestOwnVoiceIsLearnedFromFinishedSentences(t *testing.T) {
	t.Parallel()

	opened, out := newOwnVoiceSession(t, "true", stubEngines{transcribeFn: echoTranscripts, translateFn: echoTranslations})

	opened.learn(t.Context(), opened.speaker, sentence(t, opened, "de", voiceOwn, 5), "eins")
	opened.learn(t.Context(), opened.speaker, sentence(t, opened, "de", voiceOwn, 5), "zwei")

	own := opened.learn(t.Context(), opened.speaker, sentence(t, opened, "de", voiceOwn, 15), "drei")
	if own == nil || own.text != "eins zwei drei" {
		t.Fatalf("reference %+v, want the three sentences' text", own)
	}

	samples, rate, err := wav.Decode(own.wav)
	if err != nil || rate != vad.Rate || len(samples) != ownVoiceMax {
		t.Fatalf("reference audio: %d samples at %d (%v), want capped at %d", len(samples), rate, err, ownVoiceMax)
	}

	if len(notices(out, wire.NoticeOwnVoiceReady)) != 1 {
		t.Fatalf("no ready notice among %+v", out.snapshot())
	}

	if again := opened.learn(t.Context(), opened.speaker, sentence(t, opened, "de", voiceOwn, 3), "vier"); again != own {
		t.Fatal("a learned voice must be kept, not grown")
	}
}

func TestOwnVoiceSkipsFillersAndRestartsOnALanguageSwitch(t *testing.T) {
	t.Parallel()

	opened, out := newOwnVoiceSession(t, "true", stubEngines{transcribeFn: echoTranscripts, translateFn: echoTranslations})

	opened.learn(t.Context(), opened.speaker, final{
		seg: 0, lang: mustLanguage(t, opened.settings, "de"), voice: voiceOwn, audio: make([]int16, vad.Rate/2), own: nil,
	}, "äh")

	if len(notices(out, wire.NoticeOwnVoiceLearning)) != 0 {
		t.Fatal("a half-second filler counted towards the voice")
	}

	opened.learn(t.Context(), opened.speaker, sentence(t, opened, "de", voiceOwn, 8), "hallo")
	opened.learn(t.Context(), opened.speaker, sentence(t, opened, "en", voiceOwn, 8), "hello")

	learning := notices(out, wire.NoticeOwnVoiceLearning)
	if last := learning[len(learning)-1]; last.Seconds != 8 {
		t.Fatalf("after switching language the sample holds %v s, want a fresh 8", last.Seconds)
	}
}

func TestOwnVoiceNeedsCloningAndTheChoice(t *testing.T) {
	t.Parallel()

	stub := stubEngines{transcribeFn: echoTranscripts, translateFn: echoTranslations}

	without, out := newOwnVoiceSession(t, "", stub)
	if own := without.learn(t.Context(), without.speaker, sentence(t, without, "de", voiceOwn, 15), "hallo"); own != nil {
		t.Fatal("learned an own voice without VOICE_CLONING")
	}

	stock, _ := newOwnVoiceSession(t, "true", stub)
	if own := stock.learn(t.Context(), stock.speaker, sentence(t, stock, "de", voiceMale, 15), "hallo"); own != nil {
		t.Fatal("learned an own voice for a speaker who chose a stock voice")
	}

	if len(out.snapshot()) != 0 {
		t.Fatalf("notices without cloning: %+v", out.snapshot())
	}
}

func TestOwnVoiceFallsBackToTheStockVoice(t *testing.T) {
	t.Parallel()

	engines := &recordingVoice{
		transcribeFn: echoTranscripts, translateFn: echoTranslations,
		failCloned: true, mu: sync.Mutex{}, calls: nil,
	}
	opened, out := newOwnVoiceSession(t, "true", engines)

	job := sentence(t, opened, "de", voiceOwn, 1)
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
	opened.translate(t.Context(), opened.speaker, sentence(t, opened, "de", voiceFemale, 1), english, "hallo", nil)

	out.waitFor(t, finalCaption("en"))

	if calls := engines.seen(); len(calls) != 0 {
		t.Fatalf("spoke %d times with nobody listening to a voice", len(calls))
	}

	opened.setVoiceTargets(nil)
	opened.translate(t.Context(), opened.speaker, sentence(t, opened, "de", voiceFemale, 1), english, "hallo", nil)

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
