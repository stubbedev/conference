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

	"github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/interceptor/pkg/report"
	"github.com/pion/webrtc/v4"
)

// Engine owns the pion API factory shared by all peer connections.
type Engine struct {
	API *webrtc.API
}

// NewEngine builds the engine. udpPort > 0 binds all ICE traffic to a
// single UDP port (easy to publish through Docker or a firewall);
// externalIPs, when set, replace host candidates for NAT 1:1 setups.
// The returned cleanup closes the UDP mux.
func NewEngine(udpPort int, externalIPs []string) (*Engine, func(), error) {
	settingEngine, closeMux, err := newSettingEngine(udpPort, externalIPs)
	if err != nil {
		return nil, nil, err
	}

	mediaEngine, err := newMediaEngine()
	if err != nil {
		closeMux()

		return nil, nil, err
	}

	registry, err := newInterceptors()
	if err != nil {
		closeMux()

		return nil, nil, err
	}

	api := webrtc.NewAPI(
		webrtc.WithSettingEngine(settingEngine),
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(registry),
	)

	return &Engine{API: api}, closeMux, nil
}

// newSettingEngine binds the shared UDP mux and applies NAT rewrite
// rules. The returned cleanup releases the mux.
func newSettingEngine(udpPort int, externalIPs []string) (webrtc.SettingEngine, func(), error) {
	settingEngine := webrtc.SettingEngine{}

	noop := func() {}

	if udpPort > 0 {
		mux, err := ice.NewMultiUDPMuxFromPort(udpPort)
		if err != nil {
			return settingEngine, noop, fmt.Errorf("sfu: ice mux on port %d: %w", udpPort, err)
		}

		settingEngine.SetICEUDPMux(mux)

		return settingEngine, func() { _ = mux.Close() }, nil
	}

	rules := make([]webrtc.ICEAddressRewriteRule, 0, len(externalIPs))
	for _, addr := range externalIPs {
		rules = append(rules, webrtc.ICEAddressRewriteRule{
			External:        []string{addr},
			AsCandidateType: webrtc.ICECandidateTypeHost,
			Mode:            webrtc.ICEAddressRewriteReplace,
		})
	}

	if len(rules) > 0 {
		err := settingEngine.SetICEAddressRewriteRules(rules...)
		if err != nil {
			return settingEngine, noop, fmt.Errorf("sfu: address rewrite: %w", err)
		}
	}

	return settingEngine, noop, nil
}

// newMediaEngine registers the codecs and header extensions negotiated
// on every peer connection. Transport-wide congestion control is
// deliberately absent: bandwidth is controlled via REMB, which this
// server sends to publishers and both browser generations still honor.
func newMediaEngine() (*webrtc.MediaEngine, error) {
	mediaEngine := &webrtc.MediaEngine{}

	err := mediaEngine.RegisterDefaultCodecs()
	if err != nil {
		return nil, fmt.Errorf("sfu: register codecs: %w", err)
	}

	extensions := []struct {
		uri   string
		types []webrtc.RTPCodecType
	}{
		{
			"urn:ietf:params:rtp-hdrext:sdes:mid",
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

// NewPeerConnection creates a peer connection with the shared engine.
func (e *Engine) NewPeerConnection() (*webrtc.PeerConnection, error) {
	pc, err := e.API.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return nil, fmt.Errorf("sfu: new peer connection: %w", err)
	}

	return pc, nil
}
