package sfu

import (
	"bytes"
	"encoding/binary"
	"testing"
	"time"

	"github.com/pion/rtp"
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

func forward(t *testing.T, mung *munger, seq uint16, timestamp uint32, payload []byte, switching bool, now time.Time) mungedPacket {
	t.Helper()

	desc, ok := parseVP8(payload)
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

	outDesc, _ := parseVP8(rewritten)

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

	last := forward(t, &mung, 65534, 4_294_960_000, vp8Payload(true, 0x7ffe, 254, frameTag), false, now)
	if last.seq != 65534 || last.picture != 0x7ffe || last.tl0 != 254 {
		t.Fatalf("first layer was rewritten: %+v", last)
	}

	last = forward(t, &mung, 65535, 4_294_963_000, vp8Payload(true, 0x7fff, 255, deltaTag), false, now.Add(33*time.Millisecond))

	switched := forward(t, &mung, 4000, 123_456, vp8Payload(true, 0x0100, 9, frameTag), true, now.Add(66*time.Millisecond))
	expectContinues(t, last, switched)

	next := forward(t, &mung, 4001, 126_456, vp8Payload(true, 0x0101, 9, deltaTag), false, now.Add(99*time.Millisecond))
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
