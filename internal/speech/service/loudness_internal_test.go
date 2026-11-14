package service

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stubbe/conference/internal/speech/wav"
)

// tone is a sine of the given amplitude, a stand-in for a voice.
func tone(amplitude float64, n int) []int16 {
	samples := make([]int16, n)
	for i := range samples {
		samples[i] = int16(amplitude * math.Sin(float64(i)/7))
	}

	return samples
}

func scaledBy(samples []int16, factor float64) []int16 {
	scaled := make([]int16, len(samples))
	for i, sample := range samples {
		scaled[i] = int16(float64(sample) * factor)
	}

	return scaled
}

func TestAConvertedVoiceIsAsLoudAsItsStockVoice(t *testing.T) {
	t.Parallel()

	stock := tone(3000, 4800)

	for _, factor := range []float64{0.25, 0.5, 2} {
		matched := matchLoudness(scaledBy(stock, factor), stock)
		if got, want := rms(matched), rms(stock); math.Abs(got-want) > want*0.02 {
			t.Errorf("a conversion at %.2f of the stock level came out at rms %.0f, want %.0f", factor, got, want)
		}
	}
}

func TestMatchingLoudnessNeitherOverdoesNorClips(t *testing.T) {
	t.Parallel()

	stock := tone(3000, 4800)

	if got, want := rms(matchLoudness(scaledBy(stock, 1.0/20), stock)), rms(stock)/20*loudnessMaxGain; math.Abs(got-want) > want*0.05 {
		t.Errorf("a conversion at a twentieth of the stock level came out at rms %.0f, want the capped %.0f", got, want)
	}

	// Mostly quiet with one loud peak: the gain the level asks for would clip it.
	spiky := scaledBy(stock, 0.1)
	spiky[100] = 20000

	if peak := float64(peakOf(matchLoudness(spiky, stock))); peak > loudnessPeak*math.MaxInt16+1 {
		t.Errorf("matching the level drove a peak to %.0f, over %.0f", peak, loudnessPeak*math.MaxInt16)
	}

	silence := make([]int16, 480)
	if got := matchLoudness(silence, stock); peakOf(got) != 0 {
		t.Errorf("silence came out with a peak of %d", peakOf(got))
	}
}

func TestAQuietConversionReachesTheListenerAtTheStockLevel(t *testing.T) {
	t.Parallel()

	stock := tone(3000, 4800)

	// The conversion engine answers at a quarter of the level, as it does
	// for a recording made without the call's gain control.
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		quiet, err := wav.Encode(scaledBy(stock, 0.25), convertTestRate)
		if err != nil {
			t.Errorf("encode: %v", err)
		}

		_, _ = io.WriteString(w, `{"audio":"`+base64.StdEncoding.EncodeToString(quiet)+`"}`)
	}))
	t.Cleanup(engine.Close)

	api, _ := fakeAPI(t)
	engines := newHTTPEngines(convertingSettings(t, api, engine.URL+"/v1"))
	own := &reference{wav: []byte("RIFFwave"), text: sampleText, stock: voiceFemale}

	converted, err := engines.converted(t.Context(), stock, convertTestRate, speech{pcm: nil, rate: convertTestRate, converting: 0}, own)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}

	heard := make([]int16, len(converted.pcm)/pcmWidth)

	err = binary.Read(bytes.NewReader(converted.pcm), binary.LittleEndian, heard)
	if err != nil {
		t.Fatalf("read the voice: %v", err)
	}

	if got, want := rms(heard), rms(stock); math.Abs(got-want) > want*0.02 {
		t.Errorf("the listener gets the converted voice at rms %.0f, want the stock voice's %.0f", got, want)
	}
}
