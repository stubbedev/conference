package service

import "math"

const (
	// The most a converted voice is turned up: one that came back quieter
	// than an eighth of its stock voice is quiet for a reason, not for the
	// level of a recording.
	loudnessMaxGain = 8.0
	// The loudest a sample may get, as a share of full scale.
	loudnessPeak = 0.95
	// Gains this close to 1 leave the voice as it is.
	loudnessTolerance = 0.05
)

// matchLoudness brings a converted voice to the loudness of the stock
// voice it was made from. A conversion model speaks at the level of the
// speaker's recording, which skips the call's gain control and often
// comes in at a quarter of a stock voice's level or less; without this a
// listener hears that speaker's translation a fraction as loud as anyone
// else's.
func matchLoudness(converted, stock []int16) []int16 {
	have, want := rms(converted), rms(stock)
	if have == 0 || want == 0 {
		return converted
	}

	gain := min(want/have, loudnessMaxGain)
	if peak := peakOf(converted); peak > 0 {
		gain = min(gain, loudnessPeak*math.MaxInt16/float64(peak))
	}

	if math.Abs(gain-1) < loudnessTolerance {
		return converted
	}

	matched := make([]int16, len(converted))
	for i, sample := range converted {
		matched[i] = int16(math.Round(float64(sample) * gain))
	}

	return matched
}

func rms(samples []int16) float64 {
	if len(samples) == 0 {
		return 0
	}

	var sum float64
	for _, sample := range samples {
		sum += float64(sample) * float64(sample)
	}

	return math.Sqrt(sum / float64(len(samples)))
}

func peakOf(samples []int16) int {
	peak := 0
	for _, sample := range samples {
		peak = max(peak, abs(int(sample)))
	}

	return peak
}

func abs(value int) int {
	if value < 0 {
		return -value
	}

	return value
}
