package sfu

import (
	"net"

	"github.com/pion/webrtc/v4"
)

// NewLoopbackEngine builds an engine whose peers gather only the IPv4
// loopback candidate. Test peers run on the same host as the SFU, and
// gathering on every interface of a multi-homed machine multiplies the
// candidate pairs until ICE cannot finish its checks in time.
func NewLoopbackEngine() (*Engine, func(), error) {
	settingEngine := webrtc.SettingEngine{}
	settingEngine.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	settingEngine.SetIncludeLoopbackCandidate(true)
	settingEngine.SetIPFilter(func(ip net.IP) bool { return ip.IsLoopback() })

	engine, err := newEngine(settingEngine, nil)
	if err != nil {
		return nil, nil, err
	}

	return engine, func() {}, nil
}
