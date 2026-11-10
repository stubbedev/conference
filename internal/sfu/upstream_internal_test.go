package sfu

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func simulcastTrack(key trackKey, kind string) *UpTrack {
	return &UpTrack{
		key: key, kind: kind, first: nil, codec: webrtc.RTPCodecCapability{}, simulcast: true, parse: parseVP8,
		extURIs: nil, mu: sync.RWMutex{}, layers: [layerCount]*upLayer{}, viewers: map[string]*upViewer{},
		demand: layerDemand{lastWanted: [layerCount]time.Time{}, sent: [layerCount]bool{}, announced: false}, stop: nil,
		delivered: atomic.Uint64{},
	}
}

// testRoom is a room with no engine behind it, for tests that drive its
// members directly.
func testRoom(slug string) *Room {
	return &Room{
		slug: slug, name: slug, limit: 0, hub: nil,
		cfg: &HubConfig{Engine: nil, Relay: nil, MaxMembers: 0, Speech: nil, Translate: false},
		mu:  sync.Mutex{}, members: map[string]*Member{}, nextShort: 0, recorder: "", translatingBy: "", rembStop: nil,
	}
}

func testJoin(slug, name string) JoinRequest {
	return JoinRequest{Slug: slug, RoomName: slug, MemberName: name, MaxMembers: 0, Priv: false, Host: "", Resume: ""}
}

func publishingOn(member *Member, which Upstream, tracks ...*UpTrack) {
	byMid := make(map[string]*UpTrack, len(tracks))
	for _, track := range tracks {
		byMid[track.key.mid] = track
	}

	member.ups[which] = &UpPeer{
		which: which, pc: nil, member: member, mu: sync.RWMutex{},
		tracks: byMid, labels: map[string]string{}, ice: newICEStash(),
		sampledAt: time.Time{}, uplink: uplinkEstimate{limit: unlimited, peak: 0}, rembCapped: false,
		opened: sync.Once{}, flowing: atomic.Pointer[time.Time]{},
	}
}

// TestLayerDemandNamesTheConnection checks that a publisher told which
// encodings are wanted learns which connection the track is on: the
// camera and the share each publish on their own connection, where both
// can sit at the same mid.
func TestLayerDemandNamesTheConnection(t *testing.T) {
	t.Parallel()

	room := testRoom("two-upstreams")

	sent := make(chan Message, 8)
	publisher := newMember(room, 1, testJoin("two-upstreams", "alice"), func(msg Message) { sent <- msg })
	room.members[publisher.ID] = publisher

	camera := simulcastTrack(trackKey{up: UpstreamMedia, mid: "0"}, KindCamera)
	screen := simulcastTrack(trackKey{up: UpstreamScreen, mid: "0"}, KindScreen)

	publishingOn(publisher, UpstreamMedia, camera)
	publishingOn(publisher, UpstreamScreen, screen)

	room.adaptLayers()
	close(sent)

	got := map[string][layerCount]bool{}

	for msg := range sent {
		if msg.Type != "layers" {
			continue
		}

		var active [layerCount]bool

		copy(active[:], msg.Active)

		got[msg.PC+"/"+msg.Mid] = active
	}

	want := map[string][layerCount]bool{
		"up/0":        {true, false, false},
		"up-screen/0": {true, false, true},
	}

	if len(got) != len(want) {
		t.Fatalf("layer demand %v, want %v", got, want)
	}

	for key, active := range want {
		if got[key] != active {
			t.Errorf("layer demand for %s is %v, want %v", key, got[key], active)
		}
	}
}

func TestShareTracksBelongOnTheShareConnection(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		kind  string
		which Upstream
	}{
		{KindAudio, UpstreamMedia},
		{KindCamera, UpstreamMedia},
		{KindTranslationPrefix + "de", UpstreamMedia},
		{KindScreen, UpstreamScreen},
		{KindScreenAudio, UpstreamScreen},
	} {
		for which := range upstreamCount {
			if got := which.carries(tc.kind); got != (which == tc.which) {
				t.Errorf("%s carries %q = %v, want %v", which, tc.kind, got, which == tc.which)
			}
		}
	}
}
