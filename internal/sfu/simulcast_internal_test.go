package sfu

import (
	"bytes"
	"encoding/binary"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

const (
	frameTag = 0x00 // VP8 frame tag byte with the inter-frame bit clear: a keyframe
	deltaTag = 0x01
)

// vp8Payload builds a payload with a 15-bit PictureID, TL0PICIDX and a
// TID byte, the descriptor Chrome sends for simulcast VP8.
func vp8Payload(start bool, picture uint16, tl0 uint8, tag byte) []byte {
	first := byte(vp8Extended)
	if start {
		first |= vp8Start
	}

	payload := []byte{first, vp8HasPictureID | vp8HasTL0PicIdx | vp8HasTID}
	payload = binary.BigEndian.AppendUint16(payload, longPictureIDFlag|picture)

	return append(payload, tl0, 0x00, tag, 0xaa, 0xbb)
}

func TestParseVP8(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name     string
		payload  []byte
		ok       bool
		keyframe bool
		picture  uint16
		tl0At    int
	}{
		{name: "keyframe start", payload: vp8Payload(true, 0x1234, 7, frameTag), ok: true, keyframe: true, picture: 0x1234, tl0At: 4},
		{name: "delta start", payload: vp8Payload(true, 9, 7, deltaTag), ok: true, keyframe: false, picture: 9, tl0At: 4},
		{name: "keyframe continuation", payload: vp8Payload(false, 9, 7, frameTag), ok: true, keyframe: false, picture: 9, tl0At: 4},
		{
			name: "short picture id", payload: []byte{vp8Extended | vp8Start, vp8HasPictureID, 0x05, frameTag},
			ok: true, keyframe: true, picture: 5, tl0At: -1,
		},
		{name: "minimal descriptor", payload: []byte{vp8Start, frameTag}, ok: true, keyframe: true, picture: 0, tl0At: -1},
		{name: "truncated", payload: []byte{vp8Extended, vp8HasPictureID}, ok: false, keyframe: false, picture: 0, tl0At: -1},
		{name: "empty", payload: nil, ok: false, keyframe: false, picture: 0, tl0At: -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			desc, ok := parseVP8(tc.payload)
			if ok != tc.ok || desc.keyframe != tc.keyframe || desc.tl0PicIdxAt != tc.tl0At {
				t.Fatalf("ok=%v keyframe=%v tl0At=%d, want %v %v %d", ok, desc.keyframe, desc.tl0PicIdxAt, tc.ok, tc.keyframe, tc.tl0At)
			}

			if ok && desc.pictureIDAt >= 0 && desc.pictureID(tc.payload) != tc.picture {
				t.Fatalf("picture id %d, want %d", desc.pictureID(tc.payload), tc.picture)
			}
		})
	}
}

type mungedPacket struct {
	seq     uint16
	ts      uint32
	picture uint16
	tl0     uint8
}

func forward(
	t *testing.T, parse descriptorParser, mung *munger, seq uint16, timestamp uint32, payload []byte, switching bool, now time.Time,
) mungedPacket {
	t.Helper()

	desc, ok := parse(payload)
	if !ok {
		t.Fatalf("unparsable test payload %x", payload)
	}

	header := rtp.Header{SequenceNumber: seq, Timestamp: timestamp}
	if switching {
		mung.rebase(&header, payload, desc, now)
	}

	original := bytes.Clone(payload)
	out, rewritten := mung.apply(header, payload, desc, make([]byte, 0, len(payload)), now)

	if !bytes.Equal(payload, original) {
		t.Fatal("apply modified the shared payload")
	}

	outDesc, _ := parse(rewritten)

	return mungedPacket{
		seq: out.SequenceNumber, ts: out.Timestamp,
		picture: outDesc.pictureID(rewritten), tl0: rewritten[outDesc.tl0PicIdxAt],
	}
}

// TestMungerContinuesAcrossLayerSwitch forwards a few packets of one
// layer, then switches to another layer whose numbering is unrelated
// (and wraps around), and checks the viewer sees one continuous stream.
func TestMungerContinuesAcrossLayerSwitch(t *testing.T) {
	t.Parallel()

	mung := newMunger()

	now := time.Unix(1000, 0)

	last := forward(t, parseVP8, &mung, 65534, 4_294_960_000, vp8Payload(true, 0x7ffe, 254, frameTag), false, now)
	if last.seq != 65534 || last.picture != 0x7ffe || last.tl0 != 254 {
		t.Fatalf("first layer was rewritten: %+v", last)
	}

	last = forward(t, parseVP8, &mung, 65535, 4_294_963_000, vp8Payload(true, 0x7fff, 255, deltaTag), false, now.Add(33*time.Millisecond))

	switched := forward(t, parseVP8, &mung, 4000, 123_456, vp8Payload(true, 0x0100, 9, frameTag), true, now.Add(66*time.Millisecond))
	expectContinues(t, last, switched)

	next := forward(t, parseVP8, &mung, 4001, 126_456, vp8Payload(true, 0x0101, 9, deltaTag), false, now.Add(99*time.Millisecond))
	if next.seq != switched.seq+1 || next.ts-switched.ts != 3000 || next.picture != switched.picture+1 {
		t.Fatalf("packet after the switch %+v, want steady offsets from %+v", next, switched)
	}
}

func TestLadder(t *testing.T) {
	t.Parallel()

	steps := newLadder()

	steps.observeLoss(congestedLossFraction+1, layerHigh)
	steps.observeLoss(congestedLossFraction+1, layerHigh)

	if steps.ceiling != layerMid {
		t.Fatalf("ceiling %d after one lossy period, want one step down", steps.ceiling)
	}

	steps.tick()
	steps.observeLoss(1, layerMid)

	for range upswitchCleanTicks - 1 {
		steps.tick()
	}

	if steps.ceiling != layerMid {
		t.Fatalf("ceiling %d before enough clean ticks", steps.ceiling)
	}

	steps.tick()

	if steps.ceiling != layerHigh {
		t.Fatalf("ceiling %d after %d clean ticks, want a step up", steps.ceiling, upswitchCleanTicks)
	}

	steps.observeLoss(255, layerLow)
	steps.tick()
	steps.observeLoss(255, layerLow)

	if steps.ceiling != layerLow {
		t.Fatalf("ceiling %d, want it pinned at the lowest layer", steps.ceiling)
	}
}

func TestChooseLayer(t *testing.T) {
	t.Parallel()

	all := [layerCount]bool{true, true, true}
	lowOnly := [layerCount]bool{true, false, false}
	noHigh := [layerCount]bool{true, true, false}
	highOnly := [layerCount]bool{false, false, true}

	for _, tc := range []struct {
		name      string
		active    [layerCount]bool
		preferred int
		ceiling   int
		want      int
	}{
		{name: "everything allowed", active: all, preferred: layerHigh, ceiling: layerHigh, want: layerHigh},
		{name: "preference caps", active: all, preferred: layerLow, ceiling: layerHigh, want: layerLow},
		{name: "loss caps", active: all, preferred: layerHigh, ceiling: layerMid, want: layerMid},
		{name: "paused layer skipped", active: noHigh, preferred: layerHigh, ceiling: layerHigh, want: layerMid},
		{name: "only low sent", active: lowOnly, preferred: layerHigh, ceiling: layerHigh, want: layerLow},
		{name: "nothing allowed is sent", active: highOnly, preferred: layerLow, ceiling: layerHigh, want: layerHigh},
		{name: "nothing sent", active: [layerCount]bool{}, preferred: layerHigh, ceiling: layerHigh, want: -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			if got := chooseLayer(tc.active, tc.preferred, tc.ceiling); got != tc.want {
				t.Fatalf("chose %d, want %d", got, tc.want)
			}
		})
	}
}

// expectContinues asserts that next directly follows last in every
// munged field.
func expectContinues(t *testing.T, last, next mungedPacket) {
	t.Helper()

	if next.seq != last.seq+1 {
		t.Fatalf("sequence %d after %d, want continuous", next.seq, last.seq)
	}

	if next.picture != (last.picture+1)&pictureIDMask15 || next.tl0 != last.tl0+1 {
		t.Fatalf("picture %d tl0 %d after %d %d, want the next of each", next.picture, next.tl0, last.picture, last.tl0)
	}

	if !tsNewer(next.ts, last.ts) || next.ts-last.ts > videoClockRate {
		t.Fatalf("timestamp %d after %d, want a small forward step", next.ts, last.ts)
	}
}

// lossyPeriod reports loss above the congestion threshold for as many
// receiver reports in a row as it takes to step down.
func lossyPeriod(steps *ladder) {
	for range lossyReportsToStep {
		steps.observeLoss(congestedLossFraction+1, layerHigh)
	}
}

func TestLadderRidesOutALossBurst(t *testing.T) {
	t.Parallel()

	steps := newLadder()

	steps.observeLoss(255, layerHigh)
	steps.tick()

	if steps.ceiling != layerHigh {
		t.Fatalf("ceiling %d after one lossy report, want the layer kept through a burst", steps.ceiling)
	}

	steps.observeLoss(0, layerHigh)
	steps.observeLoss(255, layerHigh)
	steps.tick()

	if steps.ceiling != layerHigh {
		t.Fatalf("ceiling %d after two bursts a clean report apart, want them not to add up", steps.ceiling)
	}

	lossyPeriod(&steps)

	if steps.ceiling != layerMid {
		t.Fatalf("ceiling %d after sustained loss, want one step down", steps.ceiling)
	}
}

func TestLadderHoldsItsClimbThroughABurst(t *testing.T) {
	t.Parallel()

	steps := newLadder()
	lossyPeriod(&steps)
	steps.tick()

	for range upswitchCleanTicks - 1 {
		steps.tick()
	}

	steps.observeLoss(255, layerMid)
	steps.tick()

	if steps.ceiling != layerMid {
		t.Fatalf("ceiling %d, want the climb held by a lossy report on the way up", steps.ceiling)
	}
}

func TestLadderBacksOffALayerItCannotHold(t *testing.T) {
	t.Parallel()

	steps := newLadder()
	lossyPeriod(&steps)
	steps.tick()

	climb := func() int {
		ticks := 0

		for steps.ceiling != layerHigh {
			steps.tick()

			ticks++
		}

		return ticks
	}

	climbAndFail := func() int {
		ticks := climb()

		lossyPeriod(&steps)
		steps.tick()

		return ticks
	}

	first := climbAndFail()
	second := climbAndFail()
	third := climbAndFail()

	if first != upswitchCleanTicks || second != 2*upswitchCleanTicks || third != 4*upswitchCleanTicks {
		t.Fatalf("waited %d, %d and %d ticks before each attempt, want the wait to double from %d", first, second, third, upswitchCleanTicks)
	}

	climb()

	for range settledTicks {
		steps.tick()
	}

	lossyPeriod(&steps)
	steps.tick()

	if again := climbAndFail(); again != upswitchCleanTicks {
		t.Fatalf("waited %d ticks after holding a layer for a minute, want the wait forgiven back to %d", again, upswitchCleanTicks)
	}
}

func TestLayerDemandKeepsTheLowestLayerAndWhatViewersWant(t *testing.T) {
	t.Parallel()

	var demand layerDemand

	start := time.Unix(1000, 0)

	wanted, changed := demand.update(nil, start)
	if !changed || wanted != [layerCount]bool{true, false, false} {
		t.Fatalf("with nobody watching only the lowest layer is wanted, got %v (changed %v)", wanted, changed)
	}

	wanted, changed = demand.update([]int{layerHigh}, start.Add(time.Second))
	if !changed || wanted != [layerCount]bool{true, false, true} {
		t.Fatalf("a viewer of the top layer wants it at once, got %v (changed %v)", wanted, changed)
	}

	if _, changed = demand.update([]int{layerHigh}, start.Add(2*time.Second)); changed {
		t.Fatal("the same demand is not announced twice")
	}
}

func TestLayerDemandLingersBeforeALayerIsPaused(t *testing.T) {
	t.Parallel()

	var demand layerDemand

	start := time.Unix(1000, 0)
	demand.update([]int{layerMid, layerHigh}, start)

	wanted, _ := demand.update([]int{layerMid}, start.Add(layerDemandLinger-time.Second))
	if !wanted[layerHigh] {
		t.Fatal("a layer someone just stopped wanting is kept for the linger, so a viewer flipping back does not wait for it")
	}

	wanted, changed := demand.update([]int{layerMid}, start.Add(layerDemandLinger+time.Second))
	if !changed || wanted != [layerCount]bool{true, true, false} {
		t.Fatalf("a layer nobody wanted for the whole linger is paused, got %v (changed %v)", wanted, changed)
	}
}

func TestLayerDemandIgnoresViewersWithoutALayer(t *testing.T) {
	t.Parallel()

	var demand layerDemand

	wanted, _ := demand.update([]int{-1}, time.Unix(1000, 0))
	if wanted != [layerCount]bool{true, false, false} {
		t.Fatalf("a viewer with no layer yet wants nothing above the lowest, got %v", wanted)
	}
}

func TestScreenShareKeepsItsFluidLayerWithNobodyWatchingIt(t *testing.T) {
	t.Parallel()

	start := time.Unix(1000, 0)

	for _, kind := range []Kind{KindScreen, KindCamera} {
		thumbnail := &upViewer{
			local: nil, rate: newViewerRate(), mu: sync.Mutex{}, current: layerLow, target: layerLow,
			preferred: layerLow, steps: newLadder(), mung: newMunger(), buf: nil, received: unreported,
		}
		track := &UpTrack{
			key: trackKey{up: UpstreamMedia, mid: "1"}, kind: kind, first: nil, codec: webrtc.RTPCodecCapability{}, simulcast: true, parse: parseVP8,
			extURIs: nil, mu: sync.RWMutex{}, layers: [layerCount]*upLayer{}, viewers: map[string]*upViewer{"thumbnail": thumbnail},
			demand: layerDemand{lastWanted: [layerCount]time.Time{}, sent: [layerCount]bool{}, announced: false}, stop: nil,
			delivered: atomic.Uint64{},
		}

		wanted, _ := track.updateDemand(start)
		if kind == KindScreen && wanted != [layerCount]bool{true, false, true} {
			t.Fatalf("a share watched only as a thumbnail wants %v, want its fluid layer kept", wanted)
		}

		if kind == KindCamera && wanted != [layerCount]bool{true, false, false} {
			t.Fatalf("a camera watched only as a thumbnail wants %v, want only its lowest layer", wanted)
		}
	}
}

// vp9Payload builds a non-flexible VP9 payload with a 15-bit picture ID,
// layer indices and TL0PICIDX, the descriptor Chrome sends for a simulcast
// stream.
func vp9Payload(start, inter bool, picture uint16, spatial, tl0 uint8) []byte {
	first := byte(vp9HasPictureID | vp9HasLayers)
	if start {
		first |= vp9FrameStart
	}

	if inter {
		first |= vp9InterPicture
	}

	payload := []byte{first}
	payload = binary.BigEndian.AppendUint16(payload, longPictureIDFlag|picture)

	return append(payload, spatial<<vp9SpatialShift, tl0, 0xaa, 0xbb)
}

func TestParseVP9(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name     string
		payload  []byte
		ok       bool
		keyframe bool
		picture  uint16
		tl0At    int
	}{
		{name: "keyframe start", payload: vp9Payload(true, false, 0x1234, 0, 7), ok: true, keyframe: true, picture: 0x1234, tl0At: 4},
		{name: "inter picture", payload: vp9Payload(true, true, 9, 0, 7), ok: true, keyframe: false, picture: 9, tl0At: 4},
		{name: "keyframe continuation", payload: vp9Payload(false, false, 9, 0, 7), ok: true, keyframe: false, picture: 9, tl0At: 4},
		{name: "upper spatial layer", payload: vp9Payload(true, false, 9, 1, 7), ok: true, keyframe: false, picture: 9, tl0At: 4},
		{
			name: "flexible keyframe", payload: []byte{vp9HasPictureID | vp9HasLayers | vp9Flexible | vp9FrameStart, 0x05, 0x00, 0xaa},
			ok: true, keyframe: true, picture: 5, tl0At: -1,
		},
		{name: "short picture id", payload: []byte{vp9HasPictureID | vp9FrameStart, 0x05, 0xaa}, ok: true, keyframe: true, picture: 5, tl0At: -1},
		{name: "minimal descriptor", payload: []byte{vp9FrameStart, 0xaa}, ok: true, keyframe: true, picture: 0, tl0At: -1},
		{name: "truncated picture id", payload: []byte{vp9HasPictureID, vp9LongPictureID}, ok: false, keyframe: false, picture: 0, tl0At: -1},
		{name: "truncated layers", payload: []byte{vp9HasLayers | vp9FrameStart, 0x00}, ok: false, keyframe: false, picture: 0, tl0At: -1},
		{name: "empty", payload: nil, ok: false, keyframe: false, picture: 0, tl0At: -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			desc, ok := parseVP9(tc.payload)
			if ok != tc.ok || desc.keyframe != tc.keyframe || desc.tl0PicIdxAt != tc.tl0At {
				t.Fatalf("ok=%v keyframe=%v tl0At=%d, want %v %v %d", ok, desc.keyframe, desc.tl0PicIdxAt, tc.ok, tc.keyframe, tc.tl0At)
			}

			if ok && desc.pictureIDAt >= 0 && desc.pictureID(tc.payload) != tc.picture {
				t.Fatalf("picture id %d, want %d", desc.pictureID(tc.payload), tc.picture)
			}
		})
	}
}

func TestMungerContinuesAcrossVP9LayerSwitch(t *testing.T) {
	t.Parallel()

	mung := newMunger()

	now := time.Unix(1000, 0)

	last := forward(t, parseVP9, &mung, 100, 9000, vp9Payload(true, false, 0x7fff, 0, 255), false, now)
	if last.picture != 0x7fff || last.tl0 != 255 {
		t.Fatalf("first layer was rewritten: %+v", last)
	}

	switched := forward(t, parseVP9, &mung, 7000, 555_000, vp9Payload(true, false, 0x0042, 0, 3), true, now.Add(16*time.Millisecond))
	expectContinues(t, last, switched)

	next := forward(t, parseVP9, &mung, 7001, 556_500, vp9Payload(true, true, 0x0043, 0, 3), false, now.Add(33*time.Millisecond))
	if next.seq != switched.seq+1 || next.picture != switched.picture+1 {
		t.Fatalf("packet after the switch %+v, want steady offsets from %+v", next, switched)
	}
}

func TestParserForKnowsTheCodecsTheLayerSwitchReads(t *testing.T) {
	t.Parallel()

	for _, mime := range []string{webrtc.MimeTypeVP8, webrtc.MimeTypeVP9, "VIDEO/vp9"} {
		if parserFor(mime) == nil {
			t.Errorf("no descriptor parser for %s", mime)
		}
	}

	for _, mime := range []string{webrtc.MimeTypeH264, webrtc.MimeTypeAV1, webrtc.MimeTypeOpus} {
		if parserFor(mime) != nil {
			t.Errorf("a descriptor parser for %s, which the layer switch cannot read", mime)
		}
	}
}

func TestAStillScreenKeepsItsLayersWhileACameraLosesThem(t *testing.T) {
	t.Parallel()

	now := time.Unix(1000, 0)
	sparse := now.Add(-2 * time.Second)

	for _, tc := range []struct {
		kind   Kind
		active bool
	}{
		{kind: KindScreen, active: true},
		{kind: KindCamera, active: false},
	} {
		layer := newUpLayer(nil, sparse)

		track := &UpTrack{
			key: trackKey{up: UpstreamMedia, mid: "1"}, kind: tc.kind,
			first: nil, codec: webrtc.RTPCodecCapability{}, simulcast: true, parse: parseVP9,
			extURIs: nil, mu: sync.RWMutex{}, layers: [layerCount]*upLayer{layer, nil, nil}, viewers: map[string]*upViewer{},
			demand: layerDemand{lastWanted: [layerCount]time.Time{}, sent: [layerCount]bool{}, announced: false}, stop: nil,
			delivered: atomic.Uint64{},
		}

		if got := track.activeLayers(now)[layerLow]; got != tc.active {
			t.Errorf("%s layer silent for 2 s counts as active=%v, want %v", tc.kind, got, tc.active)
		}
	}
}
