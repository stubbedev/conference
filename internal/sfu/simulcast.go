package sfu

import (
	"encoding/binary"
	"time"

	"github.com/pion/rtp"
)

// Simulcast layers, lowest quality first. A camera is published as up
// to three encodings named by their RTP stream IDs (the client's
// sendEncodings use exactly these rids); audio and screen shares are a
// single stream without a rid, which is layer 0.
const (
	layerLow = iota
	layerMid
	layerHigh
	layerCount
)

const (
	ridLow  = "l"
	ridMid  = "m"
	ridHigh = "h"
)

// layerOf maps an RTP stream ID to its layer.
func layerOf(rid string) (int, bool) {
	switch rid {
	case "", ridLow:
		return layerLow, true
	case ridMid:
		return layerMid, true
	case ridHigh:
		return layerHigh, true
	default:
		return 0, false
	}
}

// VP8 payload descriptor (RFC 7741 section 4.2) bits.
const (
	vp8Extended      = 0x80
	vp8Start         = 0x10
	vp8PartitionMask = 0x07
	vp8HasPictureID  = 0x80
	vp8HasTL0PicIdx  = 0x40
	vp8HasTID        = 0x20
	vp8HasKeyIdx     = 0x10
	vp8LongPictureID = 0x80
	vp8InterFrame    = 0x01
	pictureIDMask7   = 0x7f
	pictureIDMask15  = 0x7fff

	longPictureIDFlag = uint16(vp8LongPictureID) << 8
)

// vp8Descriptor locates the rewritable fields of one VP8 RTP payload.
type vp8Descriptor struct {
	keyframe     bool // first packet of a keyframe: a safe layer switch point
	pictureIDAt  int  // byte offset of the PictureID, -1 when absent
	pictureIDLen int  // 1 (7-bit) or 2 (15-bit) bytes
	tl0PicIdxAt  int  // byte offset of TL0PICIDX, -1 when absent
}

// parseVP8 reads the payload descriptor. The VP8 frame header after it
// stays in the clear under end-to-end encryption, so the keyframe bit
// is readable here.
func parseVP8(payload []byte) (vp8Descriptor, bool) {
	desc := vp8Descriptor{keyframe: false, pictureIDAt: -1, pictureIDLen: 0, tl0PicIdxAt: -1}
	if len(payload) == 0 {
		return desc, false
	}

	first := payload[0]
	pos := 1

	if first&vp8Extended != 0 {
		var ok bool

		desc, pos, ok = parseExtension(payload, pos, desc)
		if !ok {
			return desc, false
		}
	}

	if len(payload) <= pos {
		return desc, false
	}

	start := first&vp8Start != 0 && first&vp8PartitionMask == 0
	desc.keyframe = start && payload[pos]&vp8InterFrame == 0

	return desc, true
}

// parseExtension reads the optional fields announced by the extension
// byte at pos and returns the offset of the VP8 payload header.
func parseExtension(payload []byte, pos int, desc vp8Descriptor) (vp8Descriptor, int, bool) {
	if len(payload) <= pos {
		return desc, pos, false
	}

	ext := payload[pos]
	pos++

	if ext&vp8HasPictureID != 0 {
		if len(payload) <= pos {
			return desc, pos, false
		}

		desc.pictureIDAt = pos
		desc.pictureIDLen = 1

		if payload[pos]&vp8LongPictureID != 0 {
			desc.pictureIDLen = 2
		}

		pos += desc.pictureIDLen
	}

	if ext&vp8HasTL0PicIdx != 0 {
		desc.tl0PicIdxAt = pos
		pos++
	}

	if ext&(vp8HasTID|vp8HasKeyIdx) != 0 {
		pos++
	}

	return desc, pos, true
}

func (d vp8Descriptor) pictureID(payload []byte) uint16 {
	if d.pictureIDLen == 1 {
		return uint16(payload[d.pictureIDAt] & pictureIDMask7)
	}

	return binary.BigEndian.Uint16(payload[d.pictureIDAt:]) & pictureIDMask15
}

func (d vp8Descriptor) pictureIDMask() uint16 {
	if d.pictureIDLen == 1 {
		return pictureIDMask7
	}

	return pictureIDMask15
}

func (d vp8Descriptor) setPictureID(payload []byte, id uint16) {
	if d.pictureIDLen == 1 {
		var both [2]byte

		binary.BigEndian.PutUint16(both[:], id&pictureIDMask7)
		payload[d.pictureIDAt] = both[1]

		return
	}

	binary.BigEndian.PutUint16(payload[d.pictureIDAt:], longPictureIDFlag|id&pictureIDMask15)
}

const (
	videoClockRate   = 90_000
	minTimestampStep = 1
)

// munger makes the packets one viewer receives from one track look like
// a single continuous stream although they come from different simulcast
// layers over time. Each layer has its own sequence numbers, RTP
// timestamp base and VP8 picture numbering; forwarded verbatim, a switch
// looks like a jump backwards and the browser's jitter buffer discards
// the new layer as stale. Offsets are recomputed at every switch (always
// on a keyframe) so the output continues right after the last packet
// sent, and applied unchanged in between, which keeps retransmissions
// and reordering intact.
type munger struct {
	started bool
	lastAt  time.Time

	seqDelta uint16
	tsDelta  uint32
	picDelta uint16
	tl0Delta uint8

	lastSeq uint16
	lastTS  uint32
	lastPic uint16
	lastTL0 uint8
	hasPic  bool
	hasTL0  bool
}

func newMunger() munger {
	return munger{
		started: false, lastAt: time.Time{},
		seqDelta: 0, tsDelta: 0, picDelta: 0, tl0Delta: 0,
		lastSeq: 0, lastTS: 0, lastPic: 0, lastTL0: 0, hasPic: false, hasTL0: false,
	}
}

// rebase aligns the deltas so the packet about to be forwarded (the
// first of a new layer) continues the output stream.
func (m *munger) rebase(header *rtp.Header, payload []byte, desc vp8Descriptor, now time.Time) {
	if !m.started {
		return
	}

	m.seqDelta = m.lastSeq + 1 - header.SequenceNumber

	step := uint32(now.Sub(m.lastAt).Seconds() * videoClockRate)
	m.tsDelta = m.lastTS + max(step, minTimestampStep) - header.Timestamp

	if desc.pictureIDAt >= 0 && m.hasPic {
		m.picDelta = (m.lastPic + 1 - desc.pictureID(payload)) & desc.pictureIDMask()
	}

	if desc.tl0PicIdxAt >= 0 && m.hasTL0 {
		m.tl0Delta = m.lastTL0 + 1 - payload[desc.tl0PicIdxAt]
	}
}

// apply rewrites one packet. The payload is shared with every other
// viewer of the track, so a rewritten descriptor is written into buf.
func (m *munger) apply(header rtp.Header, payload []byte, desc vp8Descriptor, buf []byte, now time.Time) (rtp.Header, []byte) {
	header = m.applyHeader(header, now)

	rewrite := (desc.pictureIDAt >= 0 && m.picDelta != 0) || (desc.tl0PicIdxAt >= 0 && m.tl0Delta != 0)
	if rewrite {
		buf = append(buf[:0], payload...)
		payload = buf
	}

	m.applyPictureID(payload, desc, rewrite)
	m.applyTL0PicIdx(payload, desc, rewrite)

	return header, payload
}

func (m *munger) applyHeader(header rtp.Header, now time.Time) rtp.Header {
	header.SequenceNumber += m.seqDelta
	header.Timestamp += m.tsDelta

	if !m.started || seqNewer(header.SequenceNumber, m.lastSeq) {
		m.lastSeq = header.SequenceNumber
	}

	if !m.started || tsNewer(header.Timestamp, m.lastTS) {
		m.lastTS = header.Timestamp
		m.lastAt = now
	}

	m.started = true

	return header
}

func (m *munger) applyPictureID(payload []byte, desc vp8Descriptor, rewrite bool) {
	if desc.pictureIDAt < 0 {
		return
	}

	pic := (desc.pictureID(payload) + m.picDelta) & desc.pictureIDMask()
	if rewrite {
		desc.setPictureID(payload, pic)
	}

	if !m.hasPic || picNewer(pic, m.lastPic, desc.pictureIDMask()) {
		m.lastPic = pic
	}

	m.hasPic = true
}

func (m *munger) applyTL0PicIdx(payload []byte, desc vp8Descriptor, rewrite bool) {
	if desc.tl0PicIdxAt < 0 {
		return
	}

	tl0 := payload[desc.tl0PicIdxAt] + m.tl0Delta
	if rewrite {
		payload[desc.tl0PicIdxAt] = tl0
	}

	if !m.hasTL0 || tl0Newer(tl0, m.lastTL0) {
		m.lastTL0 = tl0
	}

	m.hasTL0 = true
}

func seqNewer(a, b uint16) bool { return a != b && a-b < 1<<15 }

func tsNewer(a, b uint32) bool { return a != b && a-b < 1<<31 }

func tl0Newer(a, b uint8) bool { return a != b && a-b < 1<<7 }

func picNewer(a, b, mask uint16) bool {
	diff := (a - b) & mask

	return diff != 0 && diff <= mask/2
}

const (
	// Receiver-report loss above which a viewer steps down one layer.
	congestedLossFraction = highLossFraction
	// Consecutive loss-free adaptation ticks before stepping back up.
	upswitchCleanTicks = 5
)

// ladder is a viewer's loss-driven quality ceiling for one simulcast
// track. Heavy loss steps it down a layer at once; a run of clean ticks
// steps it back up. Receiver-estimated bandwidth (REMB) is not used:
// browsers cap it near 1.5x what they currently receive, so a viewer on
// the low layer could never earn its way back up.
type ladder struct {
	ceiling    int
	congested  bool
	cleanTicks int
}

func newLadder() ladder {
	return ladder{ceiling: layerHigh, congested: false, cleanTicks: 0}
}

// observeLoss records one receiver report's loss fraction (1/256 units).
func (l *ladder) observeLoss(fractionLost uint8, current int) {
	if fractionLost <= congestedLossFraction {
		return
	}

	if !l.congested {
		l.ceiling = max(min(l.ceiling, current)-1, layerLow)
	}

	l.congested = true
	l.cleanTicks = 0
}

// tick closes one adaptation period.
func (l *ladder) tick() {
	if l.congested {
		l.congested = false

		return
	}

	l.cleanTicks++
	if l.cleanTicks >= upswitchCleanTicks && l.ceiling < layerHigh {
		l.ceiling++
		l.cleanTicks = 0
	}
}

// chooseLayer picks the layer to forward: the highest layer being sent
// that neither the viewer's preference nor its loss ceiling rules out,
// else the lowest layer being sent. -1 means nothing is being sent.
func chooseLayer(active [layerCount]bool, preferred, ceiling int) int {
	limit := min(preferred, ceiling)

	for layer := limit; layer >= layerLow; layer-- {
		if active[layer] {
			return layer
		}
	}

	for layer := range layerCount {
		if active[layer] {
			return layer
		}
	}

	return -1
}
