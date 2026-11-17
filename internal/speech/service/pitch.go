package service

import (
	"math"
	"slices"

	"github.com/stubbe/conference/internal/speech/vad"
)

const (
	pitchFrame    = vad.Rate / 25 // 40 ms
	pitchHop      = vad.Rate / 50 // 20 ms
	pitchLowest   = 70.0
	pitchHighest  = 400.0
	pitchVoiced   = 0.5
	pitchNearPeak = 0.9
	pitchMinRMS   = 300.0
	// Between the typical pitch of a male (about 110 Hz) and a female
	// (about 210 Hz) speaking voice.
	pitchSplit = 160.0
)

// closestStock is the stock voice nearer a speaker's own pitch, the one a
// conversion into their voice starts from: female or male by the median
// pitch of the voiced parts of their recording, the default when it has
// too little voice to tell.
func closestStock(audio []int16) voiceChoice {
	pitch, ok := medianPitch(audio)
	if !ok {
		return defaultVoice
	}

	if pitch < pitchSplit {
		return voiceMale
	}

	return voiceFemale
}

// medianPitch is the median fundamental frequency, in Hz, of the voiced
// 40 ms frames of 16 kHz audio, by autocorrelation; ok is false when no
// frame is voiced.
func medianPitch(audio []int16) (float64, bool) {
	var pitches []float64

	for start := 0; start+pitchFrame <= len(audio); start += pitchHop {
		pitch, ok := framePitch(audio[start : start+pitchFrame])
		if ok {
			pitches = append(pitches, pitch)
		}
	}

	if len(pitches) == 0 {
		return 0, false
	}

	slices.Sort(pitches)

	return pitches[len(pitches)/2], true
}

func framePitch(frame []int16) (float64, bool) {
	samples, loud := frameSamples(frame)
	if !loud {
		return 0, false
	}

	rate := float64(vad.Rate)
	shortest := int(rate / pitchHighest)
	longest := int(rate / pitchLowest)

	correlations, best := autocorrelations(samples, shortest, longest)
	if best < pitchVoiced {
		return 0, false
	}

	// The shortest period near the best one, so a pitch isn't taken for
	// its own octave below.
	for lag := shortest; lag <= longest; lag++ {
		if correlations[lag] >= pitchNearPeak*best && (lag == longest || correlations[lag] >= correlations[lag+1]) {
			return rate / float64(lag), true
		}
	}

	return 0, false
}

// frameSamples is the frame as floats, and whether it is loud enough to
// carry a voice.
func frameSamples(frame []int16) ([]float64, bool) {
	samples := make([]float64, len(frame))

	var energy float64

	for i, sample := range frame {
		samples[i] = float64(sample)
		energy += samples[i] * samples[i]
	}

	return samples, math.Sqrt(energy/float64(len(samples))) >= pitchMinRMS
}

// autocorrelations is the normalized autocorrelation of samples at every
// lag from shortest to longest, and the highest of them.
func autocorrelations(samples []float64, shortest, longest int) ([]float64, float64) {
	correlations := make([]float64, longest+1)
	best := 0.0

	for lag := shortest; lag <= longest; lag++ {
		var product, early, late float64

		for i := 0; i+lag < len(samples); i++ {
			product += samples[i] * samples[i+lag]
			early += samples[i] * samples[i]
			late += samples[i+lag] * samples[i+lag]
		}

		if early > 0 && late > 0 {
			correlations[lag] = product / math.Sqrt(early*late)
		}

		best = max(best, correlations[lag])
	}

	return correlations, best
}
