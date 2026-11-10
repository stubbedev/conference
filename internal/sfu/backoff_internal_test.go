package sfu

import "testing"

// TestBackedOff is the back-off both estimates share. A period that used
// what its limit allows backs off to what got through it; one that used
// little of the limit, or had none to use, backs off from the most the
// link has delivered, held to the limit in place.
func TestBackedOff(t *testing.T) {
	t.Parallel()

	const (
		peak    = burstRate
		limit   = burstRate / 2
		quarter = fractionScale / 4
		half    = fractionScale / 2
		floor   = 100_000
	)

	for _, tc := range []struct {
		name   string
		sample linkSample
		limit  bitrateLimit
		lost   uint8
		want   uint64
	}{
		{
			name:   "no limit yet: from the most delivered",
			sample: idleLoss(), limit: unlimited, lost: half, want: backOff(peak, half),
		},
		{
			name:   "little of the limit used: from the limit",
			sample: idleLoss(), limit: capAt(limit), lost: half, want: backOff(limit, half),
		},
		{
			name:   "little of a limit above the peak used: from the peak",
			sample: idleLoss(), limit: capAt(2 * peak), lost: half, want: backOff(peak, half),
		},
		{
			name:   "the limit used: to what got through",
			sample: second(limit/2, burstPackets, burstPackets/2), limit: capAt(limit), lost: half, want: backOff(limit/2, half),
		},
		{
			name:   "never below the floor",
			sample: second(floor, burstPackets, burstPackets/4), limit: capAt(floor), lost: quarter, want: floor,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			if got := tc.sample.backedOff(tc.limit, peak, tc.lost, floor); got != capAt(tc.want) {
				t.Fatalf("limit %+v, want %d", got, tc.want)
			}
		})
	}
}
