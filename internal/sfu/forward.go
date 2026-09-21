package sfu

import (
	"errors"
	"fmt"
	"log"
	"math"
	"strings"
	"sync"

	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
)

// errNoCodecMatch is returned from Bind when the viewer negotiated none
// of the publisher's codecs; pion then reports it through the sender.
var errNoCodecMatch = errors.New("sfu: viewer negotiated no matching codec")

// forwardTrack relays one publisher track to one viewer. It is the
// downstream TrackLocal handed to pion, and it owns the per-hop RTP
// header rewrite an SFU must do: SSRC and payload type come from the
// viewer's negotiation, and header-extension IDs are translated from
// the publisher's extmap to the viewer's by URI.
//
// The extension rewrite is not optional. Browsers negotiate extension
// IDs per peer connection, so the ID a publisher uses for
// ssrc-audio-level can be the ID the viewer negotiated for sdes:mid.
// Forwarded verbatim, the viewer reads the audio-level byte as a MID,
// finds no such media section and drops the packet — every audio packet
// vanishes while video, which carries no always-on extension, arrives
// fine. Extensions the viewer did not negotiate are stripped.
type forwardTrack struct {
	id       string
	streamID string
	kind     webrtc.RTPCodecType
	codec    webrtc.RTPCodecCapability

	mu      sync.RWMutex
	binding *forwardBinding
}

// forwardBinding is the viewer-side negotiation result for one track.
type forwardBinding struct {
	ssrc        webrtc.SSRC
	payloadType webrtc.PayloadType
	writer      webrtc.TrackLocalWriter
	extIDs      map[string]uint8 // extension URI -> viewer's negotiated ID
}

func newForwardTrack(codec webrtc.RTPCodecCapability, id, streamID string) *forwardTrack {
	kind := webrtc.RTPCodecTypeVideo
	if strings.HasPrefix(strings.ToLower(codec.MimeType), "audio/") {
		kind = webrtc.RTPCodecTypeAudio
	}

	return &forwardTrack{
		id:       id,
		streamID: streamID,
		kind:     kind,
		codec:    codec,
		mu:       sync.RWMutex{},
		binding:  nil,
	}
}

func (f *forwardTrack) ID() string                { return f.id }
func (f *forwardTrack) RID() string               { return "" }
func (f *forwardTrack) StreamID() string          { return f.streamID }
func (f *forwardTrack) Kind() webrtc.RTPCodecType { return f.kind }

// Bind records what the viewer negotiated for this track. pion calls it
// once signaling for the media section has completed.
func (f *forwardTrack) Bind(ctx webrtc.TrackLocalContext) (webrtc.RTPCodecParameters, error) {
	codec, ok := matchCodec(f.codec, ctx.CodecParameters())
	if !ok {
		log.Printf("sfu: bind track=%s codec=%s: no matching codec among %d negotiated", f.id, f.codec.MimeType, len(ctx.CodecParameters()))

		return webrtc.RTPCodecParameters{}, errNoCodecMatch
	}

	extIDs := make(map[string]uint8, len(ctx.HeaderExtensions()))
	for _, ext := range ctx.HeaderExtensions() {
		if id, valid := extensionID(ext.ID); valid {
			extIDs[ext.URI] = id
		}
	}

	f.mu.Lock()
	f.binding = &forwardBinding{
		ssrc:        ctx.SSRC(),
		payloadType: codec.PayloadType,
		writer:      ctx.WriteStream(),
		extIDs:      extIDs,
	}
	f.mu.Unlock()

	log.Printf("sfu: bind track=%s ssrc=%d pt=%d codec=%s exts=%d", f.id, ctx.SSRC(), codec.PayloadType, codec.MimeType, len(extIDs))

	return codec, nil
}

// Unbind forgets the viewer negotiation; later writes are dropped.
func (f *forwardTrack) Unbind(webrtc.TrackLocalContext) error {
	f.mu.Lock()
	f.binding = nil
	f.mu.Unlock()

	return nil
}

// midExtensionURI names the sdes:mid header extension. Its value
// identifies an m-line of the peer connection that produced the packet,
// so it is only meaningful inside that negotiation: the downstream
// m-line numbering routinely differs from the publisher's (tracks are
// added in whatever order they register), and a forwarded mid value
// makes browsers demux bundled RTP onto the wrong receiver — audio
// packets cached onto the video m-line decode as nothing and the call
// goes one-way until reload. Viewers fall back to the a=ssrc lines the
// downstream offer announces per m-line, which are per-viewer and
// always correct, so the extension is stripped rather than re-numbered.
const midExtensionURI = "urn:ietf:params:rtp-hdrext:sdes:mid"

// WriteRTP forwards one publisher packet. srcExtURIs maps the
// publisher's negotiated extension IDs to their URIs; extensions the
// viewer also negotiated are re-numbered, the mid extension is
// stripped (see midExtensionURI), and the rest are dropped. Packets
// written before Bind are discarded silently, matching pion's own
// TrackLocalStaticRTP.
func (f *forwardTrack) WriteRTP(packet *rtp.Packet, srcExtURIs map[uint8]string) error {
	f.mu.RLock()
	binding := f.binding
	f.mu.RUnlock()

	if binding == nil {
		return nil
	}

	header := packet.Header
	header.SSRC = uint32(binding.ssrc)
	header.PayloadType = uint8(binding.payloadType)
	header.Extension = false
	header.ExtensionProfile = 0
	header.Extensions = nil

	for _, srcID := range packet.GetExtensionIDs() {
		uri, known := srcExtURIs[srcID]
		if !known || uri == midExtensionURI {
			continue
		}

		dstID, negotiated := binding.extIDs[uri]
		if !negotiated {
			continue
		}

		// SetExtension only fails when the ID or payload does not fit
		// the header profile chosen by the first extension; such an
		// extension is dropped rather than failing the packet.
		_ = header.SetExtension(dstID, packet.GetExtension(srcID))
	}

	_, err := binding.writer.WriteRTP(&header, packet.Payload)
	if err != nil {
		return fmt.Errorf("sfu: forward write: %w", err)
	}

	return nil
}

// matchCodec finds the viewer's negotiated parameters for the
// publisher's codec: an exact MIME type + fmtp match first, then MIME
// type alone (the fmtp differences browsers tolerate anyway).
func matchCodec(
	want webrtc.RTPCodecCapability,
	negotiated []webrtc.RTPCodecParameters,
) (webrtc.RTPCodecParameters, bool) {
	for _, codec := range negotiated {
		if strings.EqualFold(codec.MimeType, want.MimeType) && codec.SDPFmtpLine == want.SDPFmtpLine {
			return codec, true
		}
	}

	for _, codec := range negotiated {
		if strings.EqualFold(codec.MimeType, want.MimeType) {
			return codec, true
		}
	}

	return webrtc.RTPCodecParameters{}, false
}

// extensionURIs indexes a receiver's negotiated header extensions by ID,
// the shape WriteRTP needs to translate a publisher's packets.
func extensionURIs(receiver *webrtc.RTPReceiver) map[uint8]string {
	params := receiver.GetParameters()
	uris := make(map[uint8]string, len(params.HeaderExtensions))

	for _, ext := range params.HeaderExtensions {
		if id, valid := extensionID(ext.ID); valid {
			uris[id] = ext.URI
		}
	}

	return uris
}

// extensionID narrows a negotiated extmap ID to the byte the RTP header
// carries; IDs outside 1..255 cannot appear in a packet and are ignored.
func extensionID(id int) (uint8, bool) {
	if id < 1 || id > math.MaxUint8 {
		return 0, false
	}

	return uint8(id), true
}
