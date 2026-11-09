// Package sfu implements the transport-agnostic video core: a hub of live
// rooms where each member publishes one upstream peer connection and
// subscribes to every other member through per-source downstream
// peer connections. RTP packets are forwarded opaquely, which is what
// makes client-side end-to-end encryption possible: the server never
// holds media keys and only ever relays ciphertext.
//
// The forwarding design follows Galène (https://github.com/jech/galene):
// publishers offer upstream, the server offers downstream, ICE is
// trickled over the signaling channel, and keyframe requests travel as
// signaling messages that the server translates into upstream RTCP PLIs.
package sfu

import (
	"fmt"
	"net"
	"net/netip"

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/interceptor/pkg/report"
	"github.com/pion/webrtc/v4"

	"github.com/stubbe/conference/internal/relay"
)

// Engine owns the pion API factories: one for the connections members
// publish on, one for the connections they watch others on.
type Engine struct {
	upstream   *webrtc.API
	downstream *webrtc.API

	mediaAddrs []relay.MediaAddr
}

// NewEngine builds the engine. udpPort > 0 binds all ICE traffic to a
// single UDP port (easy to publish through Docker or a firewall);
// externalIPs, when set, replace host candidates for NAT 1:1 setups.
// The returned cleanup closes the UDP mux.
func NewEngine(udpPort int, externalIPs []netip.Addr) (*Engine, func(), error) {
	settingEngine, mediaAddrs, closeMux, err := newSettingEngine(udpPort, externalIPs)
	if err != nil {
		return nil, nil, err
	}

	engine, err := newEngine(settingEngine, mediaAddrs)
	if err != nil {
		closeMux()

		return nil, nil, err
	}

	return engine, closeMux, nil
}

// newEngine builds the engine on settingEngine with the SFU's codecs
// and interceptors.
func newEngine(settingEngine webrtc.SettingEngine, mediaAddrs []relay.MediaAddr) (*Engine, error) {
	upstream, err := newAPI(settingEngine, directionUpstream)
	if err != nil {
		return nil, err
	}

	downstream, err := newAPI(settingEngine, directionDownstream)
	if err != nil {
		return nil, err
	}

	return &Engine{upstream: upstream, downstream: downstream, mediaAddrs: mediaAddrs}, nil
}

type direction int

const (
	directionUpstream direction = iota
	directionDownstream
)

func newAPI(settingEngine webrtc.SettingEngine, dir direction) (*webrtc.API, error) {
	mediaEngine, err := newMediaEngine()
	if err != nil {
		return nil, err
	}

	registry, err := newInterceptors()
	if err != nil {
		return nil, err
	}

	if dir == directionUpstream {
		err = webrtc.ConfigureTWCCSender(mediaEngine, registry)
		if err != nil {
			return nil, fmt.Errorf("sfu: transport-wide congestion control feedback: %w", err)
		}
	}

	return webrtc.NewAPI(
		webrtc.WithSettingEngine(settingEngine),
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(registry),
	), nil
}

// MediaAddrs lists the addresses the SFU announces on its UDP mux and
// the local sockets behind them. It is empty without a mux (ephemeral
// ports), where no fixed address exists to relay to.
func (e *Engine) MediaAddrs() []relay.MediaAddr {
	return e.mediaAddrs
}

// newSettingEngine binds the shared UDP mux and applies NAT rewrite
// rules. The returned cleanup releases the mux.
func newSettingEngine(udpPort int, externalIPs []netip.Addr) (webrtc.SettingEngine, []relay.MediaAddr, func(), error) {
	settingEngine := webrtc.SettingEngine{}

	noop := func() {}

	rules := make([]webrtc.ICEAddressRewriteRule, 0, len(externalIPs))
	for _, addr := range externalIPs {
		rules = append(rules, webrtc.ICEAddressRewriteRule{
			External:        []string{addr.String()},
			AsCandidateType: webrtc.ICECandidateTypeHost,
			Mode:            webrtc.ICEAddressRewriteReplace,
		})
	}

	if len(rules) > 0 {
		err := settingEngine.SetICEAddressRewriteRules(rules...)
		if err != nil {
			return settingEngine, nil, noop, fmt.Errorf("sfu: address rewrite %v: %w", externalIPs, err)
		}
	}

	if udpPort == 0 {
		return settingEngine, nil, noop, nil
	}

	mux, err := ice.NewMultiUDPMuxFromPort(udpPort)
	if err != nil {
		return settingEngine, nil, noop, fmt.Errorf("sfu: ice mux on port %d: %w", udpPort, err)
	}

	settingEngine.SetICEUDPMux(mux)

	return settingEngine, mediaAddrs(mux.GetListenAddresses(), externalIPs), func() { _ = mux.Close() }, nil
}

// mediaAddrs pairs what the SFU announces with where it listens. With
// external IPs, each one is announced for the first local socket of
// its family (pion replaces every host candidate of that family with
// it); without, every local socket announces itself.
func mediaAddrs(listen []net.Addr, externalIPs []netip.Addr) []relay.MediaAddr {
	locals := make([]netip.AddrPort, 0, len(listen))

	for _, addr := range listen {
		udp, ok := addr.(*net.UDPAddr)
		if !ok {
			continue
		}

		local := udp.AddrPort()
		locals = append(locals, netip.AddrPortFrom(local.Addr().Unmap(), local.Port()))
	}

	out := make([]relay.MediaAddr, 0, len(locals))

	if len(externalIPs) == 0 {
		for _, local := range locals {
			out = append(out, relay.MediaAddr{Announced: local, Local: local})
		}

		return out
	}

	for _, external := range externalIPs {
		for _, local := range locals {
			if local.Addr().Is4() != external.Is4() {
				continue
			}

			out = append(out, relay.MediaAddr{Announced: netip.AddrPortFrom(external, local.Port()), Local: local})

			break
		}
	}

	return out
}

const (
	opusFmtp        = "minptime=10;useinbandfec=1;maxaveragebitrate=64000"
	opusClockRate   = 48_000
	opusChannels    = 2
	opusPayloadType = 111
	vp8PayloadType  = 96
	rtxPayloadType  = 97
	vp9PayloadType  = 98
	vp9RTXType      = 99
	vp9Fmtp         = "profile-id=0"
)

// registerCodecs offers exactly what end-to-end encryption can carry and
// the layer switch can read. The encryption worker leaves the first bytes
// of a VP8 frame and the Opus TOC byte in the clear; VP9's payload
// descriptor is written by the packetizer from the encoder's metadata, so
// it survives encryption whole. H.264 and AV1 packetizers parse the frame
// itself and would choke on ciphertext.
func registerCodecs(mediaEngine *webrtc.MediaEngine) error {
	videoFeedback := []webrtc.RTCPFeedback{
		{Type: "goog-remb", Parameter: ""},
		{Type: "ccm", Parameter: "fir"},
		{Type: "nack", Parameter: ""},
		{Type: "nack", Parameter: "pli"},
	}
	codecs := []struct {
		params webrtc.RTPCodecParameters
		kind   webrtc.RTPCodecType
	}{
		{codec(webrtc.MimeTypeOpus, opusClockRate, opusChannels, opusFmtp, nil, opusPayloadType), webrtc.RTPCodecTypeAudio},
		{codec(webrtc.MimeTypeVP8, videoClockRate, 0, "", videoFeedback, vp8PayloadType), webrtc.RTPCodecTypeVideo},
		{codec(webrtc.MimeTypeRTX, videoClockRate, 0, fmt.Sprintf("apt=%d", vp8PayloadType), nil, rtxPayloadType), webrtc.RTPCodecTypeVideo},
		{codec(webrtc.MimeTypeVP9, videoClockRate, 0, vp9Fmtp, videoFeedback, vp9PayloadType), webrtc.RTPCodecTypeVideo},
		{codec(webrtc.MimeTypeRTX, videoClockRate, 0, fmt.Sprintf("apt=%d", vp9PayloadType), nil, vp9RTXType), webrtc.RTPCodecTypeVideo},
	}

	for _, each := range codecs {
		err := mediaEngine.RegisterCodec(each.params, each.kind)
		if err != nil {
			return fmt.Errorf("sfu: register codec %s: %w", each.params.MimeType, err)
		}
	}

	return nil
}

func codec(
	mime string,
	clockRate uint32,
	channels uint16,
	fmtp string,
	feedback []webrtc.RTCPFeedback,
	payloadType webrtc.PayloadType,
) webrtc.RTPCodecParameters {
	return webrtc.RTPCodecParameters{
		MimeType:     mime,
		ClockRate:    clockRate,
		Channels:     channels,
		SDPFmtpLine:  fmtp,
		RTCPFeedback: feedback,
		PayloadType:  payloadType,
	}
}

// newMediaEngine registers the codecs and header extensions negotiated
// on every peer connection.
func newMediaEngine() (*webrtc.MediaEngine, error) {
	mediaEngine := &webrtc.MediaEngine{}

	err := registerCodecs(mediaEngine)
	if err != nil {
		return nil, err
	}

	extensions := []struct {
		uri   string
		types []webrtc.RTPCodecType
	}{
		{
			midExtensionURI,
			[]webrtc.RTPCodecType{webrtc.RTPCodecTypeAudio, webrtc.RTPCodecTypeVideo},
		},
		{
			"urn:ietf:params:rtp-hdrext:ssrc-audio-level",
			[]webrtc.RTPCodecType{webrtc.RTPCodecTypeAudio},
		},
		{
			"urn:ietf:params:rtp-hdrext:video-orientation",
			[]webrtc.RTPCodecType{webrtc.RTPCodecTypeVideo},
		},
		{rtpStreamIDURI, []webrtc.RTPCodecType{webrtc.RTPCodecTypeVideo}},
		{repairedRTPStreamIDURI, []webrtc.RTPCodecType{webrtc.RTPCodecTypeVideo}},
	}

	for _, ext := range extensions {
		for _, typ := range ext.types {
			capability := webrtc.RTPHeaderExtensionCapability{URI: ext.uri}

			err := mediaEngine.RegisterHeaderExtension(capability, typ)
			if err != nil {
				return nil, fmt.Errorf("sfu: register extension %s: %w", ext.uri, err)
			}
		}
	}

	return mediaEngine, nil
}

// newInterceptors builds the RTCP pipeline: NACK responses for viewers,
// NACK generation toward publishers, and sender/receiver reports in
// both directions.
func newInterceptors() (*interceptor.Registry, error) {
	registry := &interceptor.Registry{}

	responder, err := nack.NewResponderInterceptor()
	if err != nil {
		return nil, fmt.Errorf("sfu: nack responder: %w", err)
	}

	registry.Add(responder)

	generator, err := nack.NewGeneratorInterceptor()
	if err != nil {
		return nil, fmt.Errorf("sfu: nack generator: %w", err)
	}

	registry.Add(generator)

	senderReports, err := report.NewSenderInterceptor()
	if err != nil {
		return nil, fmt.Errorf("sfu: sender reports: %w", err)
	}

	registry.Add(senderReports)

	receiverReports, err := report.NewReceiverInterceptor()
	if err != nil {
		return nil, fmt.Errorf("sfu: receiver reports: %w", err)
	}

	registry.Add(receiverReports)

	return registry, nil
}

// NewUpstreamPeerConnection creates a connection a member publishes on.
func (e *Engine) NewUpstreamPeerConnection() (*webrtc.PeerConnection, error) {
	pc, err := e.upstream.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, fmt.Errorf("sfu: new upstream peer connection: %w", err)
	}

	return pc, nil
}

// NewDownstreamPeerConnection creates a connection a member watches one source on.
func (e *Engine) NewDownstreamPeerConnection() (*webrtc.PeerConnection, error) {
	pc, err := e.downstream.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, fmt.Errorf("sfu: new downstream peer connection: %w", err)
	}

	return pc, nil
}
