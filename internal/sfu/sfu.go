package sfu

import (
	"crypto/rand"
	"crypto/subtle"
	"errors"
	"fmt"
	"log"
	"maps"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"github.com/stubbe/conference/internal/relay"
)

// Kind labels what a published track carries, as the client announces
// it in offer metadata: one of the constants below, or a translated voice
// (KindTranslationPrefix and a language).
type Kind string

// The kinds of a member's own microphone, camera and shared screen.
const (
	KindAudio       Kind = "audio"
	KindCamera      Kind = "camera"
	KindScreen      Kind = "screen"
	KindScreenAudio Kind = "screen-audio"
)

// known reports whether the client may announce a track as kind.
func (k Kind) known() bool {
	if k == KindAudio || k == KindCamera || k == KindScreen || k == KindScreenAudio {
		return true
	}

	lang, translation := strings.CutPrefix(string(k), KindTranslationPrefix)

	return translation && lang != ""
}

// layered reports whether a track of this kind is published as simulcast
// layers a viewer can choose between.
func (k Kind) layered() bool {
	return k == KindCamera || k == KindScreen
}

// Moderation actions a privileged member can request for another member.
const (
	ActionMute   = "mute"
	ActionCam    = "cam"
	ActionScreen = "screen"
	ActionKick   = "kick"
	// ActionLang sets the target's live-translation language, sealed with
	// the room's chat key like their own lang message; they can change it back.
	ActionLang = "lang"
)

// Internal tuning knobs.
const (
	taskQueueDepth = 64

	// Minimum spacing between keyframe requests forwarded for one
	// viewer, so a PLI burst cannot thrash the publisher's encoder.
	keyframeRequestInterval = 200 * time.Millisecond

	// Downlink rate control, following Galène's rtpconn: a per-viewer
	// loss-driven estimate clamped by the viewer's REMB, aggregated as
	// the minimum across viewers and fed back to the publisher. Sending
	// whatever the publisher can floods constrained mobile downlinks into
	// a frozen picture no keyframe relay can recover.
	minViewerBitrate    = 9_600
	minPublisherBitrate = 100_000
	rembInterval        = time.Second

	// The SSRC the server names itself by in the feedback it sends a
	// publisher, on a connection where it sends no media of its own.
	feedbackSenderSSRC = 1

	// A simulcast layer without packets for this long counts as paused.
	// A camera sends at a steady rate, so a second of silence means its
	// encoder stopped the layer. A shared screen that does not change is
	// sent as one repeated frame a second, so its layers are only paused
	// after several seconds without any.
	cameraLayerIdleAfter = time.Second
	screenLayerIdleAfter = 4 * time.Second
)

// Sentinel errors surfaced to signaling clients and the API layer.
var (
	ErrRoomFull   = errors.New("sfu: room full")
	ErrBadRequest = errors.New("sfu: bad request")
	ErrForbidden  = errors.New("sfu: moderator access required")

	// ErrRecordingActive rejects a second recorder while one is announced.
	ErrRecordingActive = errors.New("sfu: the call is already being recorded")
)

// TrackInfo maps an SDP media section to a logical stream kind so the
// client can label incoming transceivers without parsing the SDP.
type TrackInfo struct {
	Mid  string `json:"mid"`
	Kind Kind   `json:"kind"`
}

// MemberInfo is a member as seen by signaling peers.
type MemberInfo struct {
	ID      string `json:"id"`
	Short   uint32 `json:"short"`
	Name    string `json:"name"`
	Mic     bool   `json:"mic"`
	Cam     bool   `json:"cam"`
	Sharing bool   `json:"sharing"`
}

// RoomInfo describes the room in the welcome message.
type RoomInfo struct {
	Slug  string `json:"slug"`
	Name  string `json:"name"`
	Live  int    `json:"live"`
	Limit int    `json:"limit"`
}

// JoinRequest carries the persisted room attributes the hub needs to
// spawn a live room.
type JoinRequest struct {
	Slug       string
	RoomName   string
	MemberName string
	MaxMembers int
	Priv       bool

	// Host is the hostname the member reached signaling on; its TURN
	// URLs point there.
	Host string

	// Resume is the token from an earlier welcome. A member still in
	// the room under that token is a stale connection of the same
	// client and is replaced by the new one.
	Resume string
}

// Message is the single JSON shape exchanged over the signaling
// WebSocket. Only the fields relevant to Type are meaningful.
type Message struct {
	Type string `json:"type"`

	// join
	Room    string `json:"room,omitempty"`
	Session string `json:"session,omitempty"`
	Name    string `json:"name,omitempty"`

	// join (the token to resume with) and welcome (the token to resume
	// this membership later)
	Resume string `json:"resume,omitempty"`

	// member-joined: the stale member this one replaces
	Replaces string `json:"replaces,omitempty"`

	// member events
	ID    string `json:"id,omitempty"`
	Short uint32 `json:"short,omitempty"`

	// welcome
	Self     *MemberInfo  `json:"self,omitempty"`
	RoomInfo *RoomInfo    `json:"roomInfo,omitempty"`
	Members  []MemberInfo `json:"members,omitempty"`

	ICEServers []relay.ICEServer `json:"iceServers,omitempty"`

	// media (PC names the peer connection: an upstream such as "up" or
	// "up-screen", or "down-<source>"; close names an upstream to drop)
	PC        string                   `json:"pc,omitempty"`
	SDP       string                   `json:"sdp,omitempty"`
	Tracks    []TrackInfo              `json:"tracks,omitempty"`
	Candidate *webrtc.ICECandidateInit `json:"candidate,omitempty"`

	// pli / state / chat
	Member  string `json:"member,omitempty"`
	Mic     bool   `json:"mic,omitempty"`
	Cam     bool   `json:"cam,omitempty"`
	Sharing bool   `json:"sharing,omitempty"`
	From    string `json:"from,omitempty"`
	IV      string `json:"iv,omitempty"`
	CT      string `json:"ct,omitempty"`
	TS      int64  `json:"ts,omitempty"`

	// recording announce and state (Recorder in welcome replays the
	// flag to late joiners)
	On       bool   `json:"on,omitempty"`
	Recorder string `json:"recorder,omitempty"`

	// live translation: TranslatingBy in welcome replays the room mode (the
	// member who switched it on; empty when off); translate-token carries
	// this member's token for the speech stream
	TranslatingBy string `json:"translatingBy,omitempty"`
	Token         string `json:"token,omitempty"`

	// layer (Member names the source, Kind its camera or screen, Layer
	// is a simulcast rid)
	Kind  Kind   `json:"kind,omitempty"`
	Layer string `json:"layer,omitempty"`

	// layers: which encodings of the publisher's track (Mid on the
	// upstream named by PC) any viewer wants, indexed low to high
	Mid    string `json:"mid,omitempty"`
	Active []bool `json:"active,omitempty"`

	// moderate
	Target string `json:"target,omitempty"`
	Action string `json:"action,omitempty"`

	// error
	Code string `json:"code,omitempty"`
	Text string `json:"text,omitempty"`
}

// Hub holds all live rooms.
type Hub struct {
	cfg HubConfig

	mu    sync.Mutex
	rooms map[string]*Room
}

// HubConfig wires the hub to an engine and applies limits.
type HubConfig struct {
	Engine     *Engine
	Relay      *relay.Credentials
	MaxMembers int

	// Speech streams a member's speech to the speech service; nil means
	// no server-side streams, as when every browser translates on its
	// own machine.
	Speech SpeechTokens

	// Translate lets a room switch live translation on. It is about the
	// room mode, not about which machine runs the engines.
	Translate bool
}

// NewHub creates an empty hub.
func NewHub(cfg HubConfig) *Hub {
	return &Hub{cfg: cfg, rooms: map[string]*Room{}, mu: sync.Mutex{}}
}

// JoinRoom joins the live room, creating it if necessary.
func (h *Hub) JoinRoom(req JoinRequest, send func(Message)) (*Member, error) {
	h.mu.Lock()

	room := h.rooms[req.Slug]

	if room == nil {
		limit := req.MaxMembers
		if limit <= 0 {
			limit = h.cfg.MaxMembers
		}

		room = &Room{
			slug: req.Slug, name: req.RoomName,
			limit: limit, cfg: &h.cfg,
			members: map[string]*Member{}, hub: h,
			mu: sync.Mutex{}, nextShort: 0, recorder: "", translatingBy: "", rembStop: nil,
		}
		h.rooms[req.Slug] = room
	}

	h.mu.Unlock()

	return room.join(req, send)
}

// MemberLive reports whether id is a member currently in a call.
func (h *Hub) MemberLive(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()

	for _, room := range h.rooms {
		if room.member(id) != nil {
			return true
		}
	}

	return false
}

// LiveCount returns the number of connected members in a live room.
func (h *Hub) LiveCount(slug string) int {
	h.mu.Lock()
	defer h.mu.Unlock()

	if room := h.rooms[slug]; room != nil {
		room.mu.Lock()
		defer room.mu.Unlock()

		return len(room.members)
	}

	return 0
}

// CloseRoom disconnects every member of a live room and forgets it.
func (h *Hub) CloseRoom(slug string) bool {
	h.mu.Lock()

	room := h.rooms[slug]

	delete(h.rooms, slug)
	h.mu.Unlock()

	if room == nil {
		return false
	}

	for _, member := range room.snapshot() {
		member.send(Message{Type: "error", Code: "room-closed", Text: "This room was closed by the operator."})

		member.Leave()
	}

	return true
}

// CloseAll disconnects every live room (server shutdown).
func (h *Hub) CloseAll() {
	h.mu.Lock()

	rooms := slices.Collect(maps.Values(h.rooms))

	h.rooms = map[string]*Room{}
	h.mu.Unlock()

	for _, room := range rooms {
		for _, member := range room.snapshot() {
			member.Leave()
		}
	}
}

func (h *Hub) drop(room *Room) {
	h.mu.Lock()
	delete(h.rooms, room.slug)
	h.mu.Unlock()
}

// Room is a live conference. It exists only while members are present.
type Room struct {
	slug  string
	name  string
	limit int
	cfg   *HubConfig
	hub   *Hub

	mu            sync.Mutex
	members       map[string]*Member
	nextShort     uint32
	recorder      string
	translatingBy string

	rembStop chan struct{}
}

func (r *Room) snapshot() []*Member {
	r.mu.Lock()
	defer r.mu.Unlock()

	return slices.Collect(maps.Values(r.members))
}

func (r *Room) member(id string) *Member {
	r.mu.Lock()
	defer r.mu.Unlock()

	return r.members[id]
}

func newMember(room *Room, short uint32, req JoinRequest, send func(Message)) *Member {
	return &Member{
		ID:     uuid.NewString(),
		Short:  short,
		Name:   req.MemberName,
		room:   room,
		priv:   req.Priv,
		send:   send,
		resume: rand.Text(),
		tasks:  make(chan func(), taskQueueDepth),
		done:   make(chan struct{}),
		once:   sync.Once{},
		mu:     sync.RWMutex{},
		ups:    [upstreamCount]*UpPeer{},
		downs:  map[string]*DownPeer{},
		state:  State{Mic: false, Cam: false, Sharing: false},

		layerPrefs: map[layeredStream]int{},
	}
}

// takeResumable removes and returns the member holding token, the
// stale connection of a client that is rejoining. Called with r.mu held.
func (r *Room) takeResumable(token string) *Member {
	if token == "" {
		return nil
	}

	for id, member := range r.members {
		if subtle.ConstantTimeCompare([]byte(member.resume), []byte(token)) == 1 {
			delete(r.members, id)

			return member
		}
	}

	return nil
}

// admission is the room state a join captured under the room lock.
type admission struct {
	member        *Member
	stale         *Member
	others        []MemberInfo
	translatingBy string
	startedEmpty  bool
}

// admit adds a new member, replacing the stale member that holds the
// request's resume token (a rejoining client) and handing it any
// recording that member was announcing.
func (r *Room) admit(req JoinRequest, send func(Message)) (admission, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	stale := r.takeResumable(req.Resume)

	if r.limit > 0 && len(r.members) >= r.limit {
		if stale != nil {
			r.members[stale.ID] = stale
		}

		return admission{}, ErrRoomFull
	}

	r.nextShort++

	member := newMember(r, r.nextShort, req, send)

	if stale != nil && r.recorder == stale.ID {
		r.recorder = member.ID
	}

	if stale != nil && r.translatingBy == stale.ID {
		r.translatingBy = member.ID
	}

	others := make([]MemberInfo, 0, len(r.members))
	for _, other := range r.members {
		others = append(others, other.Info())
	}

	r.members[member.ID] = member

	self := member.Info()

	member.send(Message{
		Type: "welcome", Self: &self, Members: others, Recorder: r.recorder, TranslatingBy: r.translatingBy,
		RoomInfo:   &RoomInfo{Slug: r.slug, Name: r.name, Live: len(r.members), Limit: r.limit},
		ICEServers: r.cfg.Relay.ICEServers(req.Host, member.ID), Resume: member.resume,
	})

	return admission{
		member: member, stale: stale, others: others,
		translatingBy: r.translatingBy, startedEmpty: len(r.members) == 1,
	}, nil
}

func (r *Room) join(req JoinRequest, send func(Message)) (*Member, error) {
	adm, err := r.admit(req, send)
	if err != nil {
		return nil, err
	}

	member := adm.member

	go member.run()

	replaces := ""
	if adm.stale != nil {
		replaces = adm.stale.ID
	}

	r.broadcastExcept(member.ID, Message{
		Type: "member-joined", ID: member.ID, Short: member.Short, Name: member.Name, Replaces: replaces,
	})

	// While live translation is on, a joiner translates its own speech too.
	if adm.translatingBy != "" {
		member.sendSpeechToken()
	}

	if adm.stale != nil {
		adm.stale.Leave()
	}

	if adm.startedEmpty {
		r.startRembTicker()
	}

	// Subscribe to every existing publisher.
	for _, other := range adm.others {
		sourceID := other.ID

		member.enqueue(func() { member.ensureDownPeer(sourceID) })
	}

	return member, nil
}

func (r *Room) removeMember(member *Member) {
	r.mu.Lock()
	delete(r.members, member.ID)
	remaining := slices.Collect(maps.Values(r.members))
	empty := len(r.members) == 0
	recorderLeft := r.recorder == member.ID

	if recorderLeft {
		r.recorder = ""
	}

	r.mu.Unlock()

	if !empty {
		// Peers must close their downstream connection toward the
		// departing member and stop forwarding tracks to it.
		left := member.ID

		for _, peer := range remaining {
			peer.enqueue(func() { peer.onPeerLeft(left) })
		}
	}

	if empty {
		if r.rembStop != nil {
			close(r.rembStop)

			r.rembStop = nil
		}

		r.hub.drop(r)
	}

	if recorderLeft {
		r.broadcast(Message{Type: "recording", From: member.ID, On: false})
	}

	r.broadcast(Message{Type: "member-left", ID: member.ID})
}

// claimRecording makes id the room's single announced recorder and
// reports whether the announce was allowed at all and whether it
// changed the state: the recorder re-announcing is a no-op, so no
// duplicate event reaches the room.
func (r *Room) claimRecording(id string) (bool, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.recorder != "" && r.recorder != id {
		return false, false
	}

	changed := r.recorder != id
	r.recorder = id

	return changed, true
}

// releaseRecording clears the announced recorder and reports whether id
// actually held it.
func (r *Room) releaseRecording(id string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.recorder != id {
		return false
	}

	r.recorder = ""

	return true
}

// broadcast sends msg to every member.
func (r *Room) broadcast(msg Message) {
	for _, m := range r.snapshot() {
		m.send(msg)
	}
}

// broadcastExcept sends msg to every member except exceptID.
func (r *Room) broadcastExcept(exceptID string, msg Message) {
	for _, m := range r.snapshot() {
		if m.ID != exceptID {
			m.send(msg)
		}
	}
}

// startRembTicker periodically measures every publisher connection and
// feeds each the bandwidth it may use via REMB.
func (r *Room) startRembTicker() {
	r.mu.Lock()

	if r.rembStop != nil {
		r.mu.Unlock()

		return
	}

	stop := make(chan struct{})
	r.rembStop = stop

	r.mu.Unlock()

	go func() {
		ticker := time.NewTicker(rembInterval)
		defer ticker.Stop()

		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				r.sendRemb(time.Now())
				r.adaptLayers()
			}
		}
	}()
}

func (r *Room) sendRemb(now time.Time) {
	for _, peer := range r.snapshot() {
		for _, upPeer := range peer.upstreamPeers() {
			upPeer.sendRemb(now)
		}
	}
}

// sendRemb closes one measurement period of this connection and feeds it
// the bandwidth it may use, so each upstream's estimate follows only the
// tracks it carries and the link they share.
func (up *UpPeer) sendRemb(now time.Time) {
	sample := up.measure(now)

	limit := up.viewerLimit()
	if up.which.feedback() == feedbackReceiverEstimate {
		up.uplink = up.uplink.next(sample)
		limit = limit.tighter(up.uplink.limit)
	}

	ssrcs := up.videoSSRCs()
	if len(ssrcs) == 0 {
		return
	}

	bitrate, send := rembFor(up.which.feedback(), limit, up.rembCapped)
	if !send {
		return
	}

	up.rembCapped = limit.bound

	up.writeRemb(bitrate, ssrcs)
}

// openUplink sends a connection's first REMB the moment its first video
// packet arrives, not at the next tick: libwebrtc only starts its
// estimate from a REMB that lands within two seconds of its first
// receiver report, and a share whose first REMB missed that window
// climbs 8% a second from where it started instead. Nothing has been
// measured on the connection yet, so nothing limits it.
func (up *UpPeer) openUplink(ssrc webrtc.SSRC) {
	up.opened.Do(func() {
		bitrate, send := rembFor(up.which.feedback(), unlimited, false)
		if send {
			up.writeRemb(bitrate, []uint32{uint32(ssrc)})
		}
	})
}

func (up *UpPeer) writeRemb(bitrate uint64, ssrcs []uint32) {
	packet := &rtcp.ReceiverEstimatedMaximumBitrate{
		SenderSSRC: feedbackSenderSSRC,
		Bitrate:    float32(bitrate),
		SSRCs:      ssrcs,
	}

	err := up.pc.WriteRTCP([]rtcp.Packet{packet})
	if err != nil {
		log.Printf("room %s member %.6s %s: remb: %v", up.member.room.slug, up.member.ID, up.which, err)
	}
}

// measure closes the period since the previous one: every track learns
// the rate it delivered, and the connection gets what all of them
// delivered together. The connection's first period only counts from its
// first packet: spread over the whole period, the burst a share starts
// with reads as a fraction of its rate, and loss in it would cut the
// estimate down to that fraction.
func (up *UpPeer) measure(now time.Time) linkSample {
	elapsed := measuredSince(up.sampledAt, up.flowing.Load(), now)
	up.sampledAt = now

	var link receiveTotals

	for _, track := range up.trackSnapshot() {
		arrived := track.measure()
		track.delivered.Store(linkSample{arrived: arrived, elapsed: elapsed}.bitrate())
		link = link.plus(arrived)
	}

	return linkSample{arrived: link, elapsed: elapsed}
}

// adaptLayers closes one adaptation period for every simulcast track:
// viewers move between layers as the publisher pauses or resumes
// encodings and as their own loss changes, and the layers someone is
// waiting to switch to get a keyframe request.
func (r *Room) adaptLayers() {
	now := time.Now()

	for _, source := range r.snapshot() {
		for _, track := range source.publishedTracks() {
			if !track.simulcast {
				continue
			}

			r.requestLayerKeyframes(source, track, track.retarget(now, true))

			if wanted, changed := track.updateDemand(now); changed {
				source.send(Message{Type: "layers", PC: track.key.up.PCID(), Mid: track.key.mid, Active: wanted[:]})
			}
		}
	}
}

// requestLayerKeyframes asks the publisher for keyframes on the given
// layers of one track.
func (r *Room) requestLayerKeyframes(source *Member, track *UpTrack, layers []int) {
	if len(layers) == 0 {
		return
	}

	source.requestPLI(track.key.up, track.layerSSRCs(layers))
}

// requestTrackKeyframe asks a publisher for a keyframe on every layer of
// one track, the one a viewer lost packets of.
func (r *Room) requestTrackKeyframe(sourceID string, track *UpTrack) {
	source := r.member(sourceID)
	if source == nil {
		return
	}

	source.requestPLI(track.key.up, track.layerSSRCs(nil))
}

// notifyTracksAdded tells every other member to subscribe to any new
// tracks of source. Called after an upstream renegotiation.
func (r *Room) notifyTracksAdded(source *Member) {
	for _, member := range r.snapshot() {
		if member.ID == source.ID {
			continue
		}

		member.enqueue(func() { member.ensureDownPeer(source.ID) })
	}
}

// notifyTracksRemoved tells every other member to drop tracks of sourceID.
func (r *Room) notifyTracksRemoved(sourceID string, keys []trackKey) {
	if len(keys) == 0 {
		return
	}

	for _, member := range r.snapshot() {
		if member.ID == sourceID {
			continue
		}

		member.enqueue(func() { member.removeDownTracks(sourceID, keys) })
	}
}

// requestKeyframe asks a publisher to produce fresh keyframes on every
// upstream. Safe from any goroutine; the write happens on the
// publisher's task loop so it cannot race an upstream renegotiation.
func (r *Room) requestKeyframe(sourceID string) {
	source := r.member(sourceID)
	if source == nil {
		return
	}

	source.enqueue(func() {
		for _, up := range source.upstreamPeers() {
			up.requestKeyframe()
		}
	})
}

// Member is one connected participant: the upstream peer connections
// that publish their media and one downstream peer connection per source
// they subscribe to.
type Member struct {
	ID    string
	Short uint32
	Name  string

	room   *Room
	priv   bool
	send   func(Message)
	resume string

	tasks chan func()
	done  chan struct{}
	once  sync.Once

	// mu guards ups and state for readers on other goroutines (members
	// subscribing to this one, the REMB ticker, room joins); both are
	// mutated only on this member's own task loop.
	mu sync.RWMutex

	ups   [upstreamCount]*UpPeer
	downs map[string]*DownPeer
	state State

	// layerPrefs maps a source's simulcast streams to the highest layer
	// this member's layout can use; guarded by mu.
	layerPrefs map[layeredStream]int
}

// layeredStream names one simulcast stream of a source: its camera or
// its shared screen, which a layout sizes independently.
type layeredStream struct {
	source string
	kind   Kind
}

// State mirrors a member's UI toggles for remote indicators.
type State struct {
	Mic     bool
	Cam     bool
	Sharing bool
}

// Info returns the wire representation of the member.
func (m *Member) Info() MemberInfo {
	m.mu.RLock()

	state := m.state

	m.mu.RUnlock()

	return MemberInfo{ID: m.ID, Short: m.Short, Name: m.Name, Mic: state.Mic, Cam: state.Cam, Sharing: state.Sharing}
}

// Handle queues a signaling message for processing on the member's own
// goroutine, serializing every peer connection mutation.
func (m *Member) Handle(msg Message) {
	m.enqueue(func() { m.apply(msg) })
}

// Leave tears the member down: peer connections close, forwarding stops,
// peers are notified. The member's own goroutine runs the teardown
// exactly once, after which queued tasks are dropped.
func (m *Member) Leave() {
	m.once.Do(func() { close(m.done) })
}

// upstream returns one of the member's publisher connections, if open.
// Safe from any goroutine; the fields are swapped only on the member's
// own task loop.
func (m *Member) upstream(which Upstream) *UpPeer {
	m.mu.RLock()
	defer m.mu.RUnlock()

	return m.ups[which]
}

// upstreamPeers returns the member's open publisher connections in a
// fixed order. Safe from any goroutine.
func (m *Member) upstreamPeers() []*UpPeer {
	m.mu.RLock()
	defer m.mu.RUnlock()

	peers := make([]*UpPeer, 0, upstreamCount)

	for _, up := range m.ups {
		if up != nil {
			peers = append(peers, up)
		}
	}

	return peers
}

// publishedTracks returns every track the member publishes, across its
// upstream connections. Safe from any goroutine.
func (m *Member) publishedTracks() []*UpTrack {
	var tracks []*UpTrack

	for _, up := range m.upstreamPeers() {
		tracks = append(tracks, up.trackSnapshot()...)
	}

	return tracks
}

// requestPLI asks one upstream for keyframes on ssrcs. Safe from any
// goroutine; the write happens on the member's task loop.
func (m *Member) requestPLI(which Upstream, ssrcs []uint32) {
	m.enqueue(func() {
		if up := m.upstream(which); up != nil {
			up.sendPLI(ssrcs)
		}
	})
}

// setUpstream installs or clears one publisher connection. Only called on
// the member's own task loop; the lock publishes the write to upstream()
// readers everywhere.
func (m *Member) setUpstream(which Upstream, up *UpPeer) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.ups[which] = up
}

// setStateIfChanged records the member's UI state and reports whether it
// changed.
func (m *Member) setStateIfChanged(next State) bool {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.state == next {
		return false
	}

	m.state = next

	return true
}

func (m *Member) run() {
	for {
		select {
		case <-m.done:
			m.teardown()

			return
		case task := <-m.tasks:
			task()
		}
	}
}

func (m *Member) enqueue(task func()) {
	select {
	case m.tasks <- task:
	case <-m.done:
	}
}

func (m *Member) fail(code string, err error) {
	log.Printf("room %s member %s: %s: %v", m.room.slug, m.ID, code, err)
	m.send(Message{Type: "error", Code: code, Text: err.Error()})
}

func (m *Member) apply(msg Message) { //nolint:cyclop // one flat case per signaling message type.
	switch msg.Type {
	case "offer":
		m.handleUpOffer(msg)
	case "close":
		m.handleUpClose(msg)
	case "answer":
		m.handleDownAnswer(msg)
	case "ice":
		m.handleICE(msg)
	case "pli":
		m.handlePLI(msg)
	case "state":
		m.handleState(msg)
	case "chat":
		m.handleChat(msg)
	case "record":
		m.handleRecord(msg)
	case "moderate":
		m.handleModerate(msg)
	case "layer":
		m.handleLayer(msg)
	case "lang":
		m.handleLang(msg)
	case "caption":
		m.handleCaption(msg)
	case "translate":
		m.handleTranslate(msg)
	case "translate-token-request":
		m.handleTokenRequest()
	}
}

// handleLayer records the highest simulcast layer this member's layout
// can use for one stream of a source (a filmstrip thumbnail needs far
// less than a pinned tile) and retargets that stream at once.
func (m *Member) handleLayer(msg Message) {
	layer, ok := layerOf(msg.Layer)
	if msg.Layer == "" || !ok || msg.Member == "" || !msg.Kind.layered() {
		m.fail("bad-layer", fmt.Errorf("%w: layer %q of %q for source %q", ErrBadRequest, msg.Layer, msg.Kind, msg.Member))

		return
	}

	m.mu.Lock()
	m.layerPrefs[layeredStream{source: msg.Member, kind: msg.Kind}] = layer
	m.mu.Unlock()

	source := m.room.member(msg.Member)
	if source == nil {
		return
	}

	for _, track := range source.publishedTracks() {
		if !track.simulcast || track.kind != msg.Kind {
			continue
		}

		track.setViewerPreference(m.ID, layer)
		m.room.requestLayerKeyframes(source, track, track.retarget(time.Now(), false))
	}
}

// layerPreference is the layout preference for one stream of a source,
// defaulting to the highest layer.
func (m *Member) layerPreference(sourceID string, kind Kind) int {
	m.mu.RLock()
	defer m.mu.RUnlock()

	if layer, ok := m.layerPrefs[layeredStream{source: sourceID, kind: kind}]; ok {
		return layer
	}

	return layerHigh
}

func (m *Member) handleDownAnswer(msg Message) {
	down := m.downs[strings.TrimPrefix(msg.PC, "down-")]
	if down == nil {
		return
	}

	down.applyAnswer(msg.SDP, m)
}

func (m *Member) handlePLI(msg Message) {
	m.room.requestKeyframe(msg.Member)
}

func (m *Member) handleState(msg Message) {
	next := State{Mic: msg.Mic, Cam: msg.Cam, Sharing: msg.Sharing}
	if !m.setStateIfChanged(next) {
		return
	}

	m.room.broadcastExcept(m.ID, Message{
		Type: "member-state", ID: m.ID,
		Mic: next.Mic, Cam: next.Cam, Sharing: next.Sharing,
	})
}

func (m *Member) handleChat(msg Message) {
	if msg.IV == "" || msg.CT == "" || len(msg.CT) > 16<<10 {
		m.fail("bad-chat", ErrBadRequest)

		return
	}

	m.room.broadcastExcept(m.ID, Message{
		Type: "chat", From: m.ID, IV: msg.IV, CT: msg.CT, TS: time.Now().UnixMilli(),
	})
}

// handleRecord toggles this member's local-recording announcement.
// Recording itself happens entirely in the announcing browser — the SFU
// never sees plaintext media — so the flag exists only to drive the
// consent badge every participant must see. It is therefore tracked
// like any other room state: one recorder at a time, open to every
// member, replayed to late joiners and cleared when the recorder leaves.
func (m *Member) handleRecord(msg Message) {
	if msg.On {
		changed, allowed := m.room.claimRecording(m.ID)
		if !allowed {
			m.fail("record-busy", ErrRecordingActive)

			return
		}

		if !changed {
			return
		}
	} else if !m.room.releaseRecording(m.ID) {
		return
	}

	m.room.broadcast(Message{Type: "recording", From: m.ID, On: msg.On})
}

// handleModerate applies a privileged member's action against another
// member: media actions instruct the target's client to disable the
// track, kick also removes the target from the room.
func (m *Member) handleModerate(msg Message) {
	if !m.priv {
		m.fail("not-allowed", ErrForbidden)

		return
	}

	target := m.room.member(msg.Target)
	if target == nil || target.ID == m.ID {
		m.fail("bad-target", ErrBadRequest)

		return
	}

	switch msg.Action {
	case ActionMute, ActionCam, ActionScreen:
		target.send(Message{Type: "forced", Action: msg.Action})
	case ActionKick:
		target.send(Message{Type: "kicked"})
		target.Leave()
	case ActionLang:
		if !sealed(msg, maxLangCiphertext) {
			m.fail("bad-lang", ErrBadRequest)

			return
		}

		target.send(Message{Type: "forced", Action: ActionLang, From: m.ID, IV: msg.IV, CT: msg.CT})
	default:
		m.fail("bad-action", ErrBadRequest)
	}
}

// handleUpOffer applies a (re)negotiation of the member's upstream peer
// connection and fans any new tracks out to subscribers.
func (m *Member) handleUpOffer(msg Message) {
	which, err := parseUpstream(msg.PC)
	if err != nil {
		m.fail("bad-offer", err)

		return
	}

	for _, info := range msg.Tracks {
		if !info.Kind.known() {
			m.fail("bad-offer", fmt.Errorf("%w: a track of unknown kind %q offered on %s", ErrBadRequest, info.Kind, which))

			return
		}

		if !which.carries(info.Kind) {
			m.fail("bad-offer", fmt.Errorf("%w: a %q track offered on %s", ErrBadRequest, info.Kind, which))

			return
		}
	}

	upPeer := m.ensureUpPeer(which)
	if upPeer == nil {
		return
	}

	m.answerUp(upPeer, msg)
}

// handleUpClose drops one upstream connection the publisher closed, as
// when a screen share ends: its tracks leave every viewer and the
// connection is released. The member's other upstreams are untouched.
func (m *Member) handleUpClose(msg Message) {
	which, err := parseUpstream(msg.PC)
	if err != nil {
		m.fail("bad-close", err)

		return
	}

	m.closeUpstream(which)
}

// closeUpstream releases one upstream connection and removes its tracks
// from every viewer.
func (m *Member) closeUpstream(which Upstream) {
	upPeer := m.upstream(which)
	if upPeer == nil {
		return
	}

	m.setUpstream(which, nil)

	tracks := upPeer.trackSnapshot()

	keys := make([]trackKey, 0, len(tracks))
	for _, track := range tracks {
		keys = append(keys, track.key)
	}

	upPeer.close()
	m.room.notifyTracksRemoved(m.ID, keys)
}

// ensureUpPeer lazily creates one upstream peer connection. It returns
// nil when creation failed; the error has already been reported.
func (m *Member) ensureUpPeer(which Upstream) *UpPeer {
	if existing := m.upstream(which); existing != nil {
		return existing
	}

	connection, err := m.room.cfg.Engine.NewUpstreamPeerConnection(which)
	if err != nil {
		m.fail("pc-create", err)

		return nil
	}

	upPeer := &UpPeer{
		which:      which,
		pc:         connection,
		member:     m,
		mu:         sync.RWMutex{},
		tracks:     map[string]*UpTrack{},
		labels:     map[string]Kind{},
		ice:        newICEStash(),
		sampledAt:  time.Now(),
		uplink:     uplinkEstimate{limit: unlimited, peak: 0},
		rembCapped: false,
		opened:     sync.Once{},
		flowing:    atomic.Pointer[time.Time]{},
	}

	m.setUpstream(which, upPeer)

	connection.OnICECandidate(m.iceSender(which.PCID()))
	connection.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		// Fires on the pion goroutine when the first packet of a track
		// arrives; registration is idempotent per mid. Late-arriving
		// tracks must reach members that joined before the publisher
		// sent media.
		now := time.Now()
		upPeer.flowing.CompareAndSwap(nil, &now)

		if track.Kind() == webrtc.RTPCodecTypeVideo {
			upPeer.openUplink(track.SSRC())
		}

		m.enqueue(func() {
			if m.upstream(which) != upPeer {
				return
			}

			upPeer.register(receiver, track, "ontrack")
			m.room.notifyTracksAdded(m)
		})
	})

	return upPeer
}

// answerUp applies the publisher's offer, answers it, and fans track
// changes out to subscribers.
func (m *Member) answerUp(upPeer *UpPeer, msg Message) {
	for _, info := range msg.Tracks {
		upPeer.labels[info.Mid] = info.Kind
	}

	offer := webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: msg.SDP}

	err := upPeer.pc.SetRemoteDescription(offer)
	if err != nil {
		m.fail("srd", err)

		return
	}

	flushErr := upPeer.ice.flush(upPeer.pc)
	if flushErr != nil {
		m.fail("ice-up", flushErr)
	}

	upPeer.syncTracks()

	answer, err := upPeer.pc.CreateAnswer(nil)
	if err != nil {
		m.fail("answer", err)

		return
	}

	err = upPeer.pc.SetLocalDescription(answer)
	if err != nil {
		m.fail("sld", err)

		return
	}

	m.send(Message{Type: "answer", PC: upPeer.which.PCID(), SDP: upPeer.pc.LocalDescription().SDP})

	// Also rescan after the answer: renegotiated-away tracks (a
	// translated voice stopped) must be torn down and fanned out.
	m.room.notifyTracksRemoved(m.ID, upPeer.pruneInactive())

	if len(upPeer.trackSnapshot()) > 0 {
		m.room.notifyTracksAdded(m)
	}
}

func (m *Member) iceSender(pcID string) func(*webrtc.ICECandidate) {
	return func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}

		init := c.ToJSON()

		m.send(Message{Type: "ice", PC: pcID, Candidate: &init})
	}
}

func (m *Member) handleICE(msg Message) {
	if msg.Candidate == nil {
		return
	}

	if sourceID, ok := strings.CutPrefix(msg.PC, "down-"); ok {
		down := m.downs[sourceID]
		if down == nil {
			return
		}

		down.addICECandidate(*msg.Candidate, m)

		return
	}

	which, err := parseUpstream(msg.PC)
	if err != nil {
		m.fail("bad-ice", err)

		return
	}

	up := m.upstream(which)
	if up == nil {
		return
	}

	candErr := up.ice.add(up.pc, *msg.Candidate)
	if candErr != nil {
		m.fail("ice-up", candErr)
	}
}

// ensureDownPeer creates (if needed) the downstream peer connection that
// carries source's tracks to this member, adds any tracks not yet
// forwarded, and renegotiates once.
func (m *Member) ensureDownPeer(sourceID string) {
	source := m.room.member(sourceID)
	if source == nil {
		return
	}

	tracks := source.publishedTracks()
	if len(tracks) == 0 {
		log.Printf("sfu: down %s viewer=%.6s source=%.6s skipped (no tracks)", m.room.slug, m.ID, sourceID)

		return
	}

	down := m.ensureDownConnection(sourceID)
	if down == nil {
		return
	}

	beforeSends := len(down.sends)

	for _, track := range tracks {
		if _, ok := down.sends[track.key]; ok {
			continue
		}

		local := newForwardTrack(
			track.codec, track.first.ID(), track.first.StreamID())

		sendOnly := webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionSendonly,
		}

		transceiver, trackErr := down.pc.AddTransceiverFromTrack(local, sendOnly)
		if trackErr != nil {
			m.fail("track-add", trackErr)

			continue
		}

		down.sends[track.key] = &downSend{local: local, kind: track.kind}
		track.addViewer(m.ID, local, m.layerPreference(sourceID, track.kind))
		down.watchFeedback(transceiver.Sender(), local, m, track)
	}

	added := len(down.sends) - beforeSends

	if added > 0 {
		log.Printf("sfu: down %s viewer=%.6s source=%.6s added=%d negotiating", m.room.slug, m.ID, sourceID, added)

		down.negotiate(m)
	}

	m.room.requestKeyframe(sourceID)
}

// ensureDownConnection lazily creates the downstream peer connection
// carrying source's media. It returns nil when creation failed; the
// error has already been reported to the member.
func (m *Member) ensureDownConnection(sourceID string) *DownPeer {
	if down := m.downs[sourceID]; down != nil {
		return down
	}

	connection, err := m.room.cfg.Engine.NewDownstreamPeerConnection()
	if err != nil {
		m.fail("pc-create", err)

		return nil
	}

	down := &DownPeer{
		sourceID:     sourceID,
		pc:           connection,
		sends:        map[trackKey]*downSend{},
		ice:          newICEStash(),
		offerPending: false,
		offerDirty:   false,
	}

	connection.OnICECandidate(m.iceSender(down.pcID()))
	m.downs[sourceID] = down

	return down
}

// removeDownTracks stops forwarding upstream tracks of sourceID to this
// member and renegotiates once.
func (m *Member) removeDownTracks(sourceID string, keys []trackKey) {
	down := m.downs[sourceID]
	if down == nil {
		return
	}

	removed := false

	for _, key := range keys {
		send := down.sends[key]
		if send == nil {
			continue
		}

		delete(down.sends, key)

		removed = true

		down.removeSender(send.local, m)
	}

	if removed {
		down.negotiate(m)
	}
}

// onPeerLeft runs on every remaining member when a peer disconnects.
func (m *Member) onPeerLeft(leftID string) {
	if down := m.downs[leftID]; down != nil {
		delete(m.downs, leftID)

		_ = down.pc.Close()
	}

	for _, up := range m.upstreamPeers() {
		up.dropViewer(leftID)
	}
}

func (m *Member) teardown() {
	for which := range upstreamCount {
		if up := m.upstream(which); up != nil {
			up.close()
			m.setUpstream(which, nil)
		}
	}

	for id, down := range m.downs {
		_ = down.pc.Close()

		delete(m.downs, id)
	}

	m.room.removeMember(m)
}

// iceStash buffers ICE candidates that arrive before a peer connection's
// remote description exists, keyed by candidate string so retries are
// idempotent. Upstream and downstream connections stage and flush
// through this one implementation.
type iceStash struct {
	pending map[string]webrtc.ICECandidateInit
}

func newICEStash() iceStash {
	return iceStash{pending: map[string]webrtc.ICECandidateInit{}}
}

// add applies the candidate right away, or stages it for flush.
func (s *iceStash) add(pc *webrtc.PeerConnection, candidate webrtc.ICECandidateInit) error {
	if pc.RemoteDescription() != nil {
		err := pc.AddICECandidate(candidate)
		if err != nil {
			return fmt.Errorf("sfu: apply ice candidate: %w", err)
		}

		return nil
	}

	s.pending[candidate.Candidate] = candidate

	return nil
}

// flush applies everything staged so far and empties the stash.
func (s *iceStash) flush(pc *webrtc.PeerConnection) error {
	var err error

	for _, candidate := range s.pending {
		err = errors.Join(err, pc.AddICECandidate(candidate))
	}

	s.pending = map[string]webrtc.ICECandidateInit{}

	return err
}

// UpPeer is one of a publisher's peer connections; the client offers,
// the server answers, media flows client-to-server.
type UpPeer struct {
	which  Upstream
	pc     *webrtc.PeerConnection
	member *Member

	// mu guards tracks: the map is mutated on the publisher's task loop
	// but read from subscribers' loops and the REMB ticker. labels and
	// ice stay on the owning loop.
	mu     sync.RWMutex
	tracks map[string]*UpTrack

	labels map[string]Kind
	ice    iceStash

	// The REMB ticker's own state: when it last measured, the estimate of
	// the uplink it keeps, and whether the browser holds a limit from it.
	sampledAt  time.Time
	uplink     uplinkEstimate
	rembCapped bool

	// opened sends the connection's first REMB once, on its first video
	// packet; see openUplink.
	opened sync.Once

	// flowing is when the connection's first packet arrived, nil before.
	flowing atomic.Pointer[time.Time]
}

// UpTrack is one forwarded upstream track, keyed by its connection and
// SDP mid. A simulcast camera has one layer per encoding; everything
// else has a single layer.
type UpTrack struct {
	key  trackKey
	kind Kind

	// first is the first layer to arrive; its stream IDs, shared by all
	// layers, describe the track to viewers.
	first *webrtc.TrackRemote

	// codec is the track's payload format, known even before the first
	// packet (see trackCodec).
	codec webrtc.RTPCodecCapability

	simulcast bool             // published as rid-named encodings
	parse     descriptorParser // reads the payload descriptor; nil when the layer switch cannot

	// extURIs maps the publisher's negotiated RTP header-extension IDs
	// to their URIs, so forwarded packets can be re-numbered per viewer.
	extURIs map[uint8]string

	mu      sync.RWMutex
	layers  [layerCount]*upLayer
	viewers map[string]*upViewer
	demand  layerDemand
	stop    chan struct{}

	// delivered is the rate the track arrived at over the last REMB
	// period, in bits per second: what each of its viewers is sent.
	delivered atomic.Uint64
}

// upLayer is one encoding of an upstream track.
type upLayer struct {
	remote     *webrtc.TrackRemote
	lastPacket atomic.Int64 // unix nanoseconds
	arrived    arrivals

	// sampled is arrived as the REMB ticker last read it.
	sampled receiveTotals
}

// newUpLayer starts an encoding whose last packet arrived at lastPacket.
func newUpLayer(remote *webrtc.TrackRemote, lastPacket time.Time) *upLayer {
	layer := &upLayer{
		remote:     remote,
		lastPacket: atomic.Int64{},
		arrived:    arrivals{bytes: atomic.Uint64{}, expected: atomic.Uint64{}, received: atomic.Uint64{}},
		sampled:    receiveTotals{bytes: 0, expected: 0, received: 0},
	}
	layer.lastPacket.Store(lastPacket.UnixNano())

	return layer
}

// upViewer is one viewer of one forwarded track: the downlink rate
// state derived from that viewer's RTCP feedback and, for simulcast,
// which layer it receives and wants.
type upViewer struct {
	local *forwardTrack
	rate  viewerRate

	mu        sync.Mutex
	current   int // layer being forwarded, -1 before the first
	target    int // layer to switch to at its next keyframe, -1 for none
	preferred int // highest layer the viewer's layout can use
	steps     ladder
	mung      munger
	buf       []byte
	received  receivedUpTo
}

// receivedUpTo is the highest sequence number a viewer reported
// receiving on a track, once it has reported one.
type receivedUpTo struct {
	seq   uint16
	known bool
}

// unreported is where a viewer starts, before its first receiver report.
//
//nolint:gochecknoglobals // an immutable value, the zero report spelled out
var unreported = receivedUpTo{seq: 0, known: false}

// idleDecoderQuiet is how long a viewer must have been forwarded nothing
// before its keyframe request can only be its decoder timing out. A
// libwebrtc receiver asks for a keyframe once no frame has been decodable
// for three seconds while packets arrived in the last five, and a still
// screen that Chrome stops encoding trips exactly that. A viewer that
// lost packets asks while the stream flows or moments after.
const idleDecoderQuiet = 2 * time.Second

// resumeGrace is how long after a paused stream flows again a keyframe
// request is still taken for the timeout the pause set off. The request
// leaves the viewer three seconds after its last decodable frame
// (kMaxWaitForFrame in libwebrtc's video_receive_stream2), and a screen
// read for three seconds and then scrolled puts that at the moment the
// first packets of the scroll are on their way: the viewer has to receive
// a whole frame of them, decrypt it and hand it to its decoder before the
// timer is disarmed. A second is room for that on a slow viewer and a slow
// path, and short of what the viewer does next when it does need a
// keyframe: a decoder that cannot go on asks every 200 ms
// (kMaxWaitForKeyFrame), a receiver whose frames stay undecodable asks
// again after another three seconds. Either request falls outside the
// grace and is relayed, at most one second or one timeout of the viewer
// later than it would have been.
const resumeGrace = time.Second

// idleKeyframeRequest reports whether a viewer's keyframe request is its
// decoder timing out on a stream the publisher stopped sending. Either
// the stream is still paused: the viewer reported holding the last packet
// it was forwarded, and nothing newer followed for idleDecoderQuiet. Or
// the stream was paused that long until resumeGrace ago at most, and the
// viewer reported holding everything forwarded before the pause: the
// request and the first frames after the pause crossed. Its picture is
// intact; relayed, the request would make the publisher's encoder open
// the next change of the screen with a keyframe, the largest frame exactly
// when the bitrate is needed most.
func idleKeyframeRequest(sent munger, received receivedUpTo, now time.Time) bool {
	if !sent.started || !received.known {
		return false
	}

	if now.Sub(sent.lastAt) >= idleDecoderQuiet {
		return !seqNewer(sent.lastSeq, received.seq)
	}

	return now.Sub(sent.resumedAt) < resumeGrace && !seqNewer(sent.pausedSeq, received.seq)
}

// viewerRate tracks a sustainable downlink bitrate for one viewer,
// following Galène's loss-based controller: multiplicative decrease on
// loss, increase while loss is low, clamped by whatever REMB the viewer
// itself reports. Before any heavy loss nothing limits the viewer but
// its REMB. The increase only happens while the viewer is sent close to
// the estimate, since a stream sending less is not probing the link, so
// the estimate never runs far above what was actually delivered. It
// recovers in both directions: the walk back up is paced by elapsed
// time, and a viewer's own REMB is taken as evidence of recovered
// headroom, so a single-layer stream that dropped during a blip returns
// to full quality in seconds instead of creeping back.
type viewerRate struct {
	mu    sync.Mutex
	loss  bitrateLimit // estimate from receiver reports, none before heavy loss
	remb  bitrateLimit // the viewer's own REMB, none before one arrives
	clean bool         // the last receiver report showed no loss
}

func newViewerRate() viewerRate {
	return viewerRate{mu: sync.Mutex{}, loss: unlimited, remb: unlimited, clean: false}
}

// Galène grows the estimate only while what is sent reaches seven
// eighths of it: below that the stream is not probing the bottleneck.
const (
	probingNum = 7
	probingDen = 8
)

// lift takes the viewer's own REMB as evidence of recovered headroom: the
// viewer measuring its own downlink sees a network recover long before a
// 5%-a-second walk notices. Callers hold vr.mu.
func (vr *viewerRate) lift(rate uint64) uint64 {
	if !vr.remb.bound {
		return rate
	}

	return max(rate, vr.remb.bps)
}

// updateLoss applies one receiver report: the fraction of packets the
// viewer lost since its previous report, elapsed ago, while it was sent
// delivered bits per second.
func (vr *viewerRate) updateLoss(fractionLost uint8, elapsed time.Duration, delivered uint64) {
	vr.mu.Lock()
	defer vr.mu.Unlock()

	if elapsed <= 0 {
		elapsed = rateGainPeriod
	}

	switch {
	case fractionLost > highLossFraction:
		vr.clean = false

		// Nothing measured yet: the track has not been sent for a full
		// period, so there is no rate to back off from.
		if delivered == 0 {
			return
		}

		vr.loss = capAt(max(backOff(vr.loss.clamp(delivered), fractionLost), minViewerBitrate))
	case fractionLost < lowLossFraction:
		vr.clean = true

		if !vr.loss.bound {
			return
		}

		rate := vr.loss.bps
		if delivered*probingDen >= rate*probingNum {
			rate = viewerGain.grow(rate, elapsed)
		}

		vr.loss = capAt(vr.lift(rate))
	}
}

func (vr *viewerRate) setREMB(bitrate float64) {
	if bitrate <= 0 {
		return
	}

	vr.mu.Lock()
	defer vr.mu.Unlock()

	vr.remb = capAt(uint64(bitrate))

	// A viewer that is not losing packets and now says it has more room
	// is right about its own link; follow it instead of waiting for the
	// ramp to rediscover the bandwidth.
	if vr.clean && vr.loss.bound {
		vr.loss = capAt(vr.lift(vr.loss.bps))
	}
}

// limit is the most the viewer can take: the tighter of its loss
// estimate and its own REMB.
func (vr *viewerRate) limit() bitrateLimit {
	vr.mu.Lock()
	defer vr.mu.Unlock()

	return vr.loss.tighter(vr.remb)
}

// isVideo reports whether the track carries video: a camera or a screen.
func (ut *UpTrack) isVideo() bool {
	return !ut.kind.audio()
}

// addLayer stores a newly arrived encoding and starts forwarding it;
// it reports false when the layer is already known.
func (ut *UpTrack) addLayer(index int, remote *webrtc.TrackRemote) bool {
	ut.mu.Lock()

	if ut.layers[index] != nil {
		ut.mu.Unlock()

		return false
	}

	layer := newUpLayer(remote, time.Now())
	ut.layers[index] = layer

	ut.mu.Unlock()

	go ut.forwardLayer(index, layer)

	return true
}

func (ut *UpTrack) forwardLayer(index int, layer *upLayer) {
	first := true

	var count sequenceCount

	for {
		select {
		case <-ut.stop:
			return
		default:
		}

		packet, attributes, err := layer.remote.ReadRTP()
		if err != nil {
			log.Printf("sfu: forward loop track=%s rid=%q kind=%s ended: %v", ut.key, layer.remote.RID(), ut.kind, err)

			return // peer connection closed
		}

		now := time.Now()
		layer.lastPacket.Store(now.UnixNano())

		if attributes.Get(webrtc.AttributeRtxPayloadType) == nil {
			count = count.observe(packet.SequenceNumber)
		}

		layer.arrived.record(packet.MarshalSize(), count)

		if first {
			first = false

			log.Printf("sfu: first packet track=%s rid=%q kind=%s ssrc=%d pt=%d",
				ut.key, layer.remote.RID(), ut.kind, packet.SSRC, packet.PayloadType)
		}

		desc := emptyDescriptor()
		if ut.parse != nil {
			desc, _ = ut.parse(packet.Payload)
		}

		ut.mu.RLock()

		viewers := slices.Collect(maps.Values(ut.viewers))

		ut.mu.RUnlock()

		for _, viewer := range viewers {
			writeErr := viewer.forward(index, packet, desc, ut.extURIs, now)
			if writeErr != nil {
				log.Printf("forward: %v", writeErr)
			}
		}
	}
}

// forward relays one packet of one layer if it is the layer this
// viewer receives, switching layers at a keyframe of the target.
func (v *upViewer) forward(layer int, packet *rtp.Packet, desc payloadDescriptor, extURIs map[uint8]string, now time.Time) error {
	v.mu.Lock()
	defer v.mu.Unlock()

	if layer != v.current {
		if layer != v.target || !desc.keyframe {
			return nil
		}

		v.mung.rebase(&packet.Header, packet.Payload, desc, now)
		v.current = layer
	}

	header, payload := v.mung.apply(packet.Header, packet.Payload, desc, v.buf, now)
	if len(payload) > 0 && &payload[0] != &packet.Payload[0] {
		v.buf = payload[:0]
	}

	return v.local.WriteRTP(&rtp.Packet{Header: header, Payload: payload}, extURIs)
}

func (ut *UpTrack) layerIdleAfter() time.Duration {
	if ut.kind == KindScreen {
		return screenLayerIdleAfter
	}

	return cameraLayerIdleAfter
}

// activeLayers reports which layers the publisher is currently sending:
// browsers pause the upper encodings when their uplink shrinks.
func (ut *UpTrack) activeLayers(now time.Time) [layerCount]bool {
	ut.mu.RLock()
	defer ut.mu.RUnlock()

	var active [layerCount]bool

	for index, layer := range ut.layers {
		active[index] = layer != nil && now.UnixNano()-layer.lastPacket.Load() < int64(ut.layerIdleAfter())
	}

	return active
}

// retarget re-evaluates every viewer's layer and returns the layers
// that need a keyframe because a viewer is waiting to switch to them.
func (ut *UpTrack) retarget(now time.Time, tick bool) []int {
	active := ut.activeLayers(now)

	ut.mu.RLock()
	viewers := slices.Collect(maps.Values(ut.viewers))
	ut.mu.RUnlock()

	var wanted [layerCount]bool

	for _, viewer := range viewers {
		if layer, waiting := viewer.retarget(active, tick); waiting {
			wanted[layer] = true
		}
	}

	var layers []int

	for layer, want := range wanted {
		if want {
			layers = append(layers, layer)
		}
	}

	return layers
}

// retarget picks the viewer's target layer and reports whether the
// viewer is waiting for a keyframe of it.
func (v *upViewer) retarget(active [layerCount]bool, tick bool) (int, bool) {
	v.mu.Lock()
	defer v.mu.Unlock()

	if tick {
		v.steps.tick()
	}

	v.target = chooseLayer(active, v.preferred, v.steps.ceiling)

	return v.target, v.target >= 0 && v.target != v.current
}

func (ut *UpTrack) updateDemand(now time.Time) ([layerCount]bool, bool) {
	ut.mu.Lock()
	defer ut.mu.Unlock()

	desired := make([]int, 0, len(ut.viewers)+1)
	for _, viewer := range ut.viewers {
		viewer.mu.Lock()
		desired = append(desired, min(viewer.preferred, viewer.steps.ceiling))
		viewer.mu.Unlock()
	}

	if ut.kind == KindScreen {
		desired = append(desired, layerHigh)
	}

	return ut.demand.update(desired, now)
}

// viewer is one viewer of the track, nil when it does not watch it.
func (ut *UpTrack) viewer(viewerID string) *upViewer {
	ut.mu.RLock()
	defer ut.mu.RUnlock()

	return ut.viewers[viewerID]
}

func (ut *UpTrack) setViewerPreference(viewerID string, layer int) {
	viewer := ut.viewer(viewerID)

	if viewer == nil {
		return
	}

	viewer.mu.Lock()
	viewer.preferred = layer
	viewer.mu.Unlock()
}

// newUpViewer is a viewer starting at layer current, -1 for none yet.
func newUpViewer(local *forwardTrack, current, preferred int) *upViewer {
	return &upViewer{
		local: local, rate: newViewerRate(),
		mu: sync.Mutex{}, current: current, target: current, preferred: preferred,
		steps: newLadder(), mung: newMunger(), buf: nil, received: unreported,
	}
}

// addViewer starts forwarding to a viewer. A single-layer track flows
// at once; a simulcast viewer starts at its first target keyframe.
func (ut *UpTrack) addViewer(viewerID string, local *forwardTrack, preferred int) {
	ut.mu.Lock()

	if viewer := ut.viewers[viewerID]; viewer != nil {
		ut.mu.Unlock()

		viewer.mu.Lock()
		viewer.local = local
		viewer.mu.Unlock()

		return
	}

	current := layerLow
	if ut.simulcast {
		current = -1
	}

	viewer := newUpViewer(local, current, preferred)
	ut.viewers[viewerID] = viewer

	ut.mu.Unlock()

	if ut.simulcast {
		viewer.retarget(ut.activeLayers(time.Now()), false)
	}
}

// viewerLimit is the smallest sustainable bitrate across this track's
// viewers, none when nobody watching is limited.
func (ut *UpTrack) viewerLimit() bitrateLimit {
	ut.mu.RLock()
	defer ut.mu.RUnlock()

	limit := unlimited

	for _, viewer := range ut.viewers {
		limit = limit.tighter(viewer.rate.limit())
	}

	return limit
}

// measure closes one REMB period of the track: what its layers delivered
// since the previous one. Only the REMB ticker calls it.
func (ut *UpTrack) measure() receiveTotals {
	ut.mu.RLock()
	defer ut.mu.RUnlock()

	var total receiveTotals

	for _, layer := range ut.layers {
		if layer == nil {
			continue
		}

		now := layer.arrived.load()
		total = total.plus(now.since(layer.sampled))
		layer.sampled = now
	}

	return total
}

func (ut *UpTrack) setViewerREMB(viewerID string, bitrate float64) {
	viewer := ut.viewer(viewerID)

	if viewer != nil {
		viewer.rate.setREMB(bitrate)
	}
}

// updateViewerReport applies one receiver report block a viewer sent
// about this track.
func (ut *UpTrack) updateViewerReport(viewerID string, report rtcp.ReceptionReport, elapsed time.Duration) {
	viewer := ut.viewer(viewerID)

	if viewer == nil {
		return
	}

	viewer.rate.updateLoss(report.FractionLost, elapsed, ut.delivered.Load())

	viewer.mu.Lock()
	viewer.steps.observeLoss(report.FractionLost, viewer.current)
	//nolint:gosec // the low 16 bits of the extended sequence number are the sequence number itself
	viewer.received = receivedUpTo{seq: uint16(report.LastSequenceNumber), known: true}
	viewer.mu.Unlock()
}

// needsKeyframe reports whether a viewer's keyframe request is one the
// publisher must answer, rather than its decoder timing out on a still
// stream.
func (ut *UpTrack) needsKeyframe(viewerID string, now time.Time) bool {
	viewer := ut.viewer(viewerID)

	if viewer == nil {
		return false
	}

	viewer.mu.Lock()
	defer viewer.mu.Unlock()

	return !idleKeyframeRequest(viewer.mung, viewer.received, now)
}

func (ut *UpTrack) dropViewer(viewerID string) {
	ut.mu.Lock()
	delete(ut.viewers, viewerID)
	ut.mu.Unlock()
}

func (ut *UpTrack) close() {
	close(ut.stop)
}

// trackSnapshot returns the registered tracks as a slice ordered by mid.
// Callers on other goroutines must iterate the snapshot, never the live map.
func (up *UpPeer) trackSnapshot() []*UpTrack {
	up.mu.RLock()
	defer up.mu.RUnlock()

	return slices.SortedFunc(maps.Values(up.tracks), func(a, b *UpTrack) int { return strings.Compare(a.key.mid, b.key.mid) })
}

// layerSSRCs lists the SSRCs of the given layers of a track; nil
// layers selects all of them.
func (ut *UpTrack) layerSSRCs(layers []int) []uint32 {
	ut.mu.RLock()
	defer ut.mu.RUnlock()

	var ssrcs []uint32

	for index, layer := range ut.layers {
		if layer == nil || (layers != nil && !slices.Contains(layers, index)) {
			continue
		}

		ssrcs = append(ssrcs, uint32(layer.remote.SSRC()))
	}

	return ssrcs
}

func (up *UpPeer) videoSSRCs() []uint32 {
	var ssrcs []uint32

	for _, track := range up.trackSnapshot() {
		if track.isVideo() {
			ssrcs = append(ssrcs, track.layerSSRCs(nil)...)
		}
	}

	return ssrcs
}

// viewerLimit is what the publisher's viewers can take on this
// connection: the minimum across viewers, Galène-style. Tracks nobody
// watches do not constrain the publisher.
func (up *UpPeer) viewerLimit() bitrateLimit {
	limit := unlimited

	for _, track := range up.trackSnapshot() {
		// Simulcast viewers adapt by layer, so they never hold the
		// publisher back.
		if !track.isVideo() || track.simulcast {
			continue
		}

		limit = limit.tighter(track.viewerLimit())
	}

	return limit
}

// requestKeyframe sends PLIs for every layer of every video track of
// this publisher.
func (up *UpPeer) requestKeyframe() {
	for _, track := range up.trackSnapshot() {
		if track.isVideo() {
			up.sendPLI(track.layerSSRCs(nil))
		}
	}
}

func (up *UpPeer) sendPLI(ssrcs []uint32) {
	for _, ssrc := range ssrcs {
		pli := &rtcp.PictureLossIndication{SenderSSRC: feedbackSenderSSRC, MediaSSRC: ssrc}

		err := up.pc.WriteRTCP([]rtcp.Packet{pli})
		if err != nil {
			log.Printf("room %s member %.6s %s: pli ssrc=%d: %v", up.member.room.slug, up.member.ID, up.which, ssrc, err)
		}
	}
}

// register records a discovered upstream track or simulcast layer.
// Idempotent per mid and layer; called both from the post-SRD scan and
// from OnTrack.
func (up *UpPeer) register(receiver *webrtc.RTPReceiver, track *webrtc.TrackRemote, via string) {
	mid := up.midOf(receiver)
	if mid == "" {
		log.Printf("sfu: register member %.6s %s via=%s ssrc=%d: no mid, dropped", up.member.ID, up.which, via, track.SSRC())

		return
	}

	key := trackKey{up: up.which, mid: mid}

	layer, known := layerOf(track.RID())
	if !known {
		log.Printf("sfu: register member %.6s track=%s: unknown rid %q, dropped", up.member.ID, key, track.RID())

		return
	}

	upTrack, created := up.trackFor(key, receiver, track)

	if !upTrack.addLayer(layer, track) {
		return
	}

	if created {
		log.Printf("sfu: register %s member %s via=%s track=%s kind=%s simulcast=%v",
			up.member.room.slug, up.member.ID, via, key, upTrack.kind, upTrack.simulcast)
	}

	log.Printf("sfu: layer %s member %.6s track=%s rid=%q ssrc=%d", up.member.room.slug, up.member.ID, key, track.RID(), track.SSRC())
}

// trackFor returns the upstream track for key, creating it from its
// first arriving layer.
func (up *UpPeer) trackFor(key trackKey, receiver *webrtc.RTPReceiver, track *webrtc.TrackRemote) (*UpTrack, bool) {
	up.mu.Lock()
	defer up.mu.Unlock()

	if existing := up.tracks[key.mid]; existing != nil {
		return existing, false
	}

	codec := trackCodec(receiver, track)

	kind := up.labels[key.mid]
	if kind == "" {
		kind = up.which.defaultKind(track.Kind())
	}

	upTrack := &UpTrack{
		key:       key,
		kind:      kind,
		first:     track,
		codec:     codec,
		simulcast: track.RID() != "",
		parse:     parserFor(codec.MimeType),
		extURIs:   extensionURIs(receiver),
		mu:        sync.RWMutex{},
		layers:    [layerCount]*upLayer{},
		viewers:   map[string]*upViewer{},
		demand:    layerDemand{lastWanted: [layerCount]time.Time{}, sent: [layerCount]bool{}, announced: false},
		stop:      make(chan struct{}),
		delivered: atomic.Uint64{},
	}
	up.tracks[key.mid] = upTrack

	return upTrack, true
}

// midOf finds the SDP mid of the media section belonging to receiver.
func (up *UpPeer) midOf(receiver *webrtc.RTPReceiver) string {
	for _, transceiver := range up.pc.GetTransceivers() {
		if transceiver.Receiver() == receiver {
			return transceiver.Mid()
		}
	}

	return ""
}

// trackCodec is the payload format of an upstream track. A track only
// learns its codec from its first packet, but one registered by
// syncTracks has none yet; the media section's negotiated codecs, the
// preferred one first, stand in, so a late audio track is not offered to
// viewers as video.
func trackCodec(receiver *webrtc.RTPReceiver, track *webrtc.TrackRemote) webrtc.RTPCodecCapability {
	if codec := track.Codec(); codec.MimeType != "" {
		return codec.RTPCodecCapability
	}

	for _, codec := range receiver.GetParameters().Codecs {
		if codec.MimeType != "" {
			return codec.RTPCodecCapability
		}
	}

	return webrtc.RTPCodecCapability{}
}

// syncTracks registers any recvonly transceivers whose track is already
// available after SetRemoteDescription.
func (up *UpPeer) syncTracks() {
	for _, transceiver := range up.pc.GetTransceivers() {
		if transceiver.Direction() != webrtc.RTPTransceiverDirectionRecvonly {
			continue
		}

		receiver := transceiver.Receiver()
		if receiver == nil || transceiver.Mid() == "" {
			continue
		}

		// Simulcast layers have no SSRC before their first packet;
		// OnTrack registers them once they arrive.
		for _, track := range receiver.Tracks() {
			if track.RID() == "" {
				up.register(receiver, track, "sync")
			}
		}
	}
}

// pruneInactive tears down upstream tracks whose media section the
// publisher deactivated (a translated voice stopped). Returns their keys.
func (up *UpPeer) pruneInactive() []trackKey {
	var removed []trackKey

	for _, transceiver := range up.pc.GetTransceivers() {
		mid := transceiver.Mid()
		if !up.trackKnown(mid) {
			continue
		}

		if transceiver.Direction() == webrtc.RTPTransceiverDirectionInactive {
			up.removeTrack(mid)

			removed = append(removed, trackKey{up: up.which, mid: mid})
		}
	}

	return removed
}

func (up *UpPeer) trackKnown(mid string) bool {
	up.mu.RLock()
	defer up.mu.RUnlock()

	_, ok := up.tracks[mid]

	return ok
}

// removeTrack forgets an upstream track and stops its forwarding loop.
func (up *UpPeer) removeTrack(mid string) {
	up.mu.Lock()

	track, found := up.tracks[mid]
	if found {
		delete(up.tracks, mid)
	}

	up.mu.Unlock()

	if found {
		track.close()
	}
}

// dropViewer removes one viewer from every forwarded track.
func (up *UpPeer) dropViewer(viewerID string) {
	for _, track := range up.trackSnapshot() {
		track.dropViewer(viewerID)
	}
}

func (up *UpPeer) close() {
	for _, track := range up.trackSnapshot() {
		track.close()
	}

	_ = up.pc.Close()
}

// downSend pairs a forwarded local track with its logical kind.
type downSend struct {
	local *forwardTrack
	kind  Kind
}

// DownPeer carries one source member's tracks to one viewer. The server
// offers, the viewer answers.
type DownPeer struct {
	sourceID string
	pc       *webrtc.PeerConnection
	sends    map[trackKey]*downSend
	ice      iceStash

	// offerPending is true while an offer is out awaiting the viewer's
	// answer; offerDirty records that tracks changed in the meantime.
	// WebRTC forbids a second SetLocalDescription(offer) before the
	// pending one is answered, and dropping the later offer would strand
	// the new tracks forever, so renegotiation is deferred to applyAnswer.
	offerPending bool
	offerDirty   bool
}

func (dp *DownPeer) pcID() string { return "down-" + dp.sourceID }

// removeSender stops sending local to the viewer.
func (dp *DownPeer) removeSender(local *forwardTrack, viewer *Member) {
	for _, transceiver := range dp.pc.GetTransceivers() {
		sender := transceiver.Sender()
		if sender == nil || sender.Track() != local {
			continue
		}

		err := dp.pc.RemoveTrack(sender)
		if err != nil {
			viewer.fail("track-remove", err)
		}

		return
	}
}

// watchFeedback relays a viewer's RTCP feedback on one forwarded track
// to the publisher: keyframe requests (PLI or FIR, what a browser sends
// after losing video packets mid-call) trigger upstream keyframes, while
// REMB and receiver-report loss feed the per-viewer rate that caps the
// publisher's bitrate. Without the relay a constrained downlink floods
// into a frozen picture no keyframe can recover. The loop ends when the
// peer connection closes and ReadRTCP fails.
func (dp *DownPeer) watchFeedback(sender *webrtc.RTPSender, local *forwardTrack, viewer *Member, track *UpTrack) {
	if sender == nil {
		return
	}

	go func() {
		var relay feedbackRelay

		for {
			packets, _, err := sender.ReadRTCP()
			if err != nil {
				return
			}

			ssrc, bound := local.boundSSRC()
			if !bound {
				continue
			}

			for _, packet := range packets {
				dp.relayFeedback(&relay, packet, viewer, track, ssrc)
			}
		}
	}()
}

// feedbackRelay is the state one viewer's feedback loop keeps between
// packets: when it last asked for a keyframe and when it last reported
// loss, which together pace the requests and the rate controller.
type feedbackRelay struct {
	keyframe time.Time
	loss     time.Time
}

// relayFeedback hands one RTCP packet from a viewer to the publisher.
// pion hands every sender of the connection each packet that names its
// SSRC, so a receiver report arrives with the blocks of the viewer's
// other tracks too; only the block about ssrc, the SSRC this track is
// sent on, describes it.
func (dp *DownPeer) relayFeedback(relay *feedbackRelay, packet rtcp.Packet, viewer *Member, track *UpTrack, ssrc uint32) {
	now := time.Now()

	switch feedback := packet.(type) {
	case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
		if now.Sub(relay.keyframe) < keyframeRequestInterval {
			return
		}

		if !track.needsKeyframe(viewer.ID, now) {
			log.Printf("sfu: viewer %.6s timed out on still track=%s, keyframe request not relayed", viewer.ID, track.key)

			return
		}

		relay.keyframe = now

		viewer.room.requestTrackKeyframe(dp.sourceID, track)
	case *rtcp.ReceiverEstimatedMaximumBitrate:
		track.setViewerREMB(viewer.ID, float64(feedback.Bitrate))
	case *rtcp.ReceiverReport:
		elapsed := rateGainPeriod
		if !relay.loss.IsZero() {
			elapsed = now.Sub(relay.loss)
		}

		relay.loss = now

		for _, report := range feedback.Reports {
			if report.SSRC == ssrc {
				track.updateViewerReport(viewer.ID, report, elapsed)
			}
		}
	}
}

// sdpSection accumulates the fingerprint fields of one media section.
type sdpSection struct {
	label   string
	hasSSRC bool
}

func (s *sdpSection) apply(line string) {
	switch {
	case strings.HasPrefix(line, "m="):
		s.label = strings.TrimPrefix(line, "m=")
	case strings.HasPrefix(line, "a=mid:"):
		s.label += " mid=" + strings.TrimPrefix(line, "a=mid:")
	case isDirection(line):
		s.label += " " + strings.TrimPrefix(line, "a=")
	case strings.HasPrefix(line, "a=ssrc:") && !s.hasSSRC:
		fields := strings.SplitN(strings.TrimPrefix(line, "a=ssrc:"), " ", 2)
		s.label += " ssrc=" + fields[0]
		s.hasSSRC = true
	}
}

func isDirection(line string) bool {
	return line == "a=sendonly" || line == "a=recvonly" || line == "a=sendrecv" || line == "a=inactive"
}

// sdpFingerprint renders the m-line layout of an SDP compactly for
// logging: media kind, mid, direction and declared SSRCs per section.
func sdpFingerprint(sdp string) string {
	var sections []string

	current := sdpSection{label: "", hasSSRC: false}

	for line := range strings.SplitSeq(sdp, "\r\n") {
		line = strings.TrimSpace(line)

		if strings.HasPrefix(line, "m=") && current.label != "" {
			sections = append(sections, current.label)
		}

		current.apply(line)
	}

	if current.label != "" {
		sections = append(sections, current.label)
	}

	return strings.Join(sections, "; ")
}

// negotiate sends a fresh offer describing everything currently in sends.
func (dp *DownPeer) negotiate(viewer *Member) {
	if dp.offerPending {
		dp.offerDirty = true

		return
	}

	offer, err := dp.pc.CreateOffer(nil)
	if err != nil {
		viewer.fail("offer", err)

		return
	}

	err = dp.pc.SetLocalDescription(offer)
	if err != nil {
		viewer.fail("sld", err)

		return
	}

	var tracks []TrackInfo

	for _, transceiver := range dp.pc.GetTransceivers() {
		sender := transceiver.Sender()
		if sender == nil || sender.Track() == nil {
			continue
		}

		for _, send := range dp.sends {
			if send.local == sender.Track() {
				tracks = append(tracks, TrackInfo{Mid: transceiver.Mid(), Kind: send.kind})
			}
		}
	}

	dp.offerPending = true

	sdp := dp.pc.LocalDescription().SDP

	log.Printf("sfu: offer %s viewer=%.6s source=%.6s [%s]", viewer.room.slug, viewer.ID, dp.sourceID, sdpFingerprint(sdp))

	viewer.send(Message{Type: "offer", PC: dp.pcID(), SDP: sdp, Tracks: tracks})
}

func (dp *DownPeer) applyAnswer(sdp string, viewer *Member) {
	answer := webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: sdp}

	err := dp.pc.SetRemoteDescription(answer)
	if err != nil {
		viewer.fail("srd", err)

		return
	}

	flushErr := dp.ice.flush(dp.pc)
	if flushErr != nil {
		viewer.fail("ice-down", flushErr)
	}

	dp.offerPending = false

	// Tracks added while the previous offer was in flight renegotiate now.
	if dp.offerDirty {
		dp.offerDirty = false
		dp.negotiate(viewer)
	}
}

func (dp *DownPeer) addICECandidate(candidate webrtc.ICECandidateInit, viewer *Member) {
	candErr := dp.ice.add(dp.pc, candidate)
	if candErr != nil {
		viewer.fail("ice-down", candErr)
	}
}
