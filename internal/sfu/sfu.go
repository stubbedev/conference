package sfu

import (
	"errors"
	"fmt"
	"log"
	"maps"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

// Track kinds as announced by the client in offer metadata.
const (
	KindAudio  = "audio"
	KindCamera = "camera"
	KindScreen = "screen"
)

// Moderation actions a privileged member can request for another member.
const (
	ActionMute   = "mute"
	ActionCam    = "cam"
	ActionScreen = "screen"
	ActionKick   = "kick"
)

// Internal tuning knobs.
const (
	taskQueueDepth = 64
	bpsPerKbps     = 1000

	// Minimum spacing between keyframe requests forwarded for one
	// viewer, so a PLI burst cannot thrash the publisher's encoder.
	keyframeRequestInterval = 200 * time.Millisecond

	// Downlink rate control, following Galène's rtpconn: a per-viewer
	// loss-driven AIMD estimate clamped by the viewer's REMB, aggregated
	// as the minimum across viewers and fed back to the publisher. A
	// fixed ceiling floods constrained mobile downlinks into a frozen
	// picture no keyframe relay can recover.
	minViewerBitrate    = 9_600
	initViewerBitrate   = 512_000
	minPublisherBitrate = 100_000
	rembInterval        = time.Second
)

// Sentinel errors surfaced to signaling clients and the API layer.
var (
	ErrRoomFull   = errors.New("sfu: room full")
	ErrBadRequest = errors.New("sfu: bad request")
	ErrForbidden  = errors.New("sfu: moderator access required")
)

// TrackInfo maps an SDP media section to a logical stream kind so the
// client can label incoming transceivers without parsing the SDP.
type TrackInfo struct {
	Mid  string `json:"mid"`
	Kind string `json:"kind"`
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
}

// Message is the single JSON shape exchanged over the signaling
// WebSocket. Only the fields relevant to Type are meaningful.
type Message struct {
	Type string `json:"type"`

	// join
	Room    string `json:"room,omitempty"`
	Session string `json:"session,omitempty"`
	Name    string `json:"name,omitempty"`

	// member events
	ID    string `json:"id,omitempty"`
	Short uint32 `json:"short,omitempty"`

	// welcome
	Self     *MemberInfo  `json:"self,omitempty"`
	RoomInfo *RoomInfo    `json:"roomInfo,omitempty"`
	Members  []MemberInfo `json:"members,omitempty"`

	// media
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
	Engine         *Engine
	MaxMembers     int
	MaxPublishKbps int
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
			mu: sync.Mutex{}, nextShort: 0, rembStop: nil,
		}
		h.rooms[req.Slug] = room
	}

	h.mu.Unlock()

	return room.join(req, send)
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

	mu        sync.Mutex
	members   map[string]*Member
	nextShort uint32

	rembStop chan struct{}
}

func (r *Room) info() *RoomInfo {
	r.mu.Lock()
	defer r.mu.Unlock()

	return &RoomInfo{Slug: r.slug, Name: r.name, Live: len(r.members), Limit: r.limit}
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

func (r *Room) join(req JoinRequest, send func(Message)) (*Member, error) {
	r.mu.Lock()

	if r.limit > 0 && len(r.members) >= r.limit {
		r.mu.Unlock()

		return nil, ErrRoomFull
	}

	r.nextShort++

	member := &Member{
		ID:    uuid.NewString(),
		Short: r.nextShort,
		Name:  req.MemberName,
		room:  r,
		priv:  req.Priv,
		send:  send,
		tasks: make(chan func(), taskQueueDepth),
		done:  make(chan struct{}),
		once:  sync.Once{},
		mu:    sync.RWMutex{},
		up:    nil,
		downs: map[string]*DownPeer{},
		state: State{Mic: false, Cam: false, Sharing: false},
	}

	var others []MemberInfo

	for _, other := range r.members {
		others = append(others, other.Info())
	}

	r.members[member.ID] = member
	startedEmpty := len(r.members) == 1
	r.mu.Unlock()

	go member.run()

	self := member.Info()

	member.send(Message{Type: "welcome", Self: &self, RoomInfo: r.info(), Members: others})
	r.broadcastExcept(member.ID, Message{
		Type: "member-joined", ID: member.ID, Short: member.Short, Name: member.Name,
	})

	if startedEmpty {
		r.startRembTicker()
	}

	// Subscribe to every existing publisher.
	for _, other := range others {
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

	r.broadcast(Message{Type: "member-left", ID: member.ID})
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

// startRembTicker periodically feeds a bandwidth ceiling to every
// publisher via REMB. Without it, Chrome ramps to its local maximum and
// can saturate the uplink behind which the server sits.
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
				r.sendRemb()
			}
		}
	}()
}

// publishCeilingBps converts the configured kbps ceiling into bps; a
// missing or invalid configuration returns 0, which disables REMB.
func publishCeilingBps(kbps int) uint64 {
	if kbps <= 0 {
		return 0
	}

	return uint64(kbps) * bpsPerKbps
}

func (r *Room) sendRemb() {
	ceiling := publishCeilingBps(r.cfg.MaxPublishKbps)
	if ceiling == 0 {
		return
	}

	for _, peer := range r.snapshot() {
		upPeer := peer.upstream()
		if upPeer == nil {
			continue
		}

		ssrcs := upPeer.videoSSRCs()
		if len(ssrcs) == 0 {
			continue
		}

		packet := &rtcp.ReceiverEstimatedMaximumBitrate{
			SenderSSRC: 1,
			Bitrate:    float32(upPeer.adaptiveBitrate(ceiling)),
			SSRCs:      ssrcs,
		}

		err := upPeer.pc.WriteRTCP([]rtcp.Packet{packet})
		if err != nil {
			log.Printf("room %s: remb: %v", r.slug, err)
		}
	}
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

// notifyTrackRemoved tells every other member to drop one track.
func (r *Room) notifyTrackRemoved(sourceID, mid string) {
	for _, member := range r.snapshot() {
		if member.ID == sourceID {
			continue
		}

		member.enqueue(func() { member.removeDownTrack(sourceID, mid) })
	}
}

// requestKeyframe asks a publisher to produce fresh keyframes. Safe from
// any goroutine; the write happens on the publisher's task loop so it
// cannot race an upstream renegotiation.
func (r *Room) requestKeyframe(sourceID string) {
	source := r.member(sourceID)
	if source == nil {
		return
	}

	source.enqueue(func() {
		up := source.upstream()
		if up != nil {
			up.requestKeyframe()
		}
	})
}

// Member is one connected participant: an upstream peer connection that
// publishes their media and one downstream peer connection per source
// they subscribe to.
type Member struct {
	ID    string
	Short uint32
	Name  string

	room *Room
	priv bool
	send func(Message)

	tasks chan func()
	done  chan struct{}
	once  sync.Once

	// mu guards up and state for readers on other goroutines (members
	// subscribing to this one, the REMB ticker, room joins); both are
	// mutated only on this member's own task loop.
	mu sync.RWMutex

	up    *UpPeer
	downs map[string]*DownPeer
	state State
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
// peers are notified.
func (m *Member) Leave() {
	m.enqueue(func() { m.teardown() })
	m.once.Do(func() { close(m.done) })
}

// upstream returns the member's publisher connection, if any. Safe from
// any goroutine; the field is swapped only on the member's own task loop.
func (m *Member) upstream() *UpPeer {
	m.mu.RLock()
	defer m.mu.RUnlock()

	return m.up
}

// setUpstream installs or clears the publisher connection. Only called on
// the member's own task loop; the lock publishes the write to upstream()
// readers everywhere.
func (m *Member) setUpstream(up *UpPeer) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.up = up
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

func (m *Member) apply(msg Message) {
	switch msg.Type {
	case "offer":
		m.handleUpOffer(msg)
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
	case "moderate":
		m.handleModerate(msg)
	}
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
	default:
		m.fail("bad-action", ErrBadRequest)
	}
}

// handleUpOffer applies a (re)negotiation of the member's upstream peer
// connection and fans any new tracks out to subscribers.
func (m *Member) handleUpOffer(msg Message) {
	m.ensureUpPeer()
	m.answerUp(msg)
}

// ensureUpPeer lazily creates the upstream peer connection.
func (m *Member) ensureUpPeer() {
	if m.upstream() != nil {
		return
	}

	connection, err := m.room.cfg.Engine.NewPeerConnection()
	if err != nil {
		m.fail("pc-create", err)

		return
	}

	upPeer := &UpPeer{
		pc:     connection,
		member: m,
		mu:     sync.RWMutex{},
		tracks: map[string]*UpTrack{},
		labels: map[string]string{},
		ice:    newICEStash(),
	}

	m.setUpstream(upPeer)

	connection.OnICECandidate(m.iceSender("up"))
	connection.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		// Fires on the pion goroutine when the first packet of a track
		// arrives; registration is idempotent per mid. Late-arriving
		// tracks must reach members that joined before the publisher
		// sent media.
		m.enqueue(func() {
			publisher := m.upstream()
			if publisher == nil {
				return
			}

			publisher.register(receiver, track, publisher.labels, "ontrack")
			m.room.notifyTracksAdded(m)
		})
	})
}

// answerUp applies the publisher's offer, answers it, and fans track
// changes out to subscribers.
func (m *Member) answerUp(msg Message) {
	upPeer := m.upstream()
	if upPeer == nil {
		return
	}

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

	m.send(Message{Type: "answer", PC: "up", SDP: upPeer.pc.LocalDescription().SDP})

	// Also rescan after the answer: renegotiated-away tracks (screen
	// share stopped) must be torn down and fanned out.
	removed := upPeer.pruneInactive()
	for _, mid := range removed {
		m.room.notifyTrackRemoved(m.ID, mid)
	}

	if upPeer.hasTracks() {
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

	switch {
	case msg.PC == "up":
		up := m.upstream()
		if up == nil {
			return
		}

		candErr := up.ice.add(up.pc, *msg.Candidate)
		if candErr != nil {
			m.fail("ice-up", candErr)
		}
	case strings.HasPrefix(msg.PC, "down-"):
		down := m.downs[strings.TrimPrefix(msg.PC, "down-")]
		if down == nil {
			return
		}

		down.addICECandidate(*msg.Candidate, m)
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

	sourceUp := source.upstream()
	if sourceUp == nil || !sourceUp.hasTracks() {
		log.Printf("sfu: down %s viewer=%.6s source=%.6s skipped (no tracks)", m.room.slug, m.ID, sourceID)

		return
	}

	down := m.ensureDownConnection(sourceID)
	if down == nil {
		return
	}

	beforeSends := len(down.sends)

	sourceUp.forEachTrack(func(track *UpTrack) {
		if _, ok := down.sends[track.mid]; ok {
			return
		}

		local := newForwardTrack(
			track.remote.Codec().RTPCodecCapability, track.remote.ID(), track.remote.StreamID())

		sendOnly := webrtc.RTPTransceiverInit{
			Direction: webrtc.RTPTransceiverDirectionSendonly,
		}

		transceiver, trackErr := down.pc.AddTransceiverFromTrack(local, sendOnly)
		if trackErr != nil {
			m.fail("track-add", trackErr)

			return
		}

		down.sends[track.mid] = &downSend{local: local, kind: track.kind}
		track.addViewer(m.ID, local)
		down.watchFeedback(transceiver.Sender(), m, track)
	})

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

	connection, err := m.room.cfg.Engine.NewPeerConnection()
	if err != nil {
		m.fail("pc-create", err)

		return nil
	}

	down := &DownPeer{
		sourceID:     sourceID,
		pc:           connection,
		sends:        map[string]*downSend{},
		ice:          newICEStash(),
		offerPending: false,
		offerDirty:   false,
	}

	connection.OnICECandidate(m.iceSender(down.pcID()))
	m.downs[sourceID] = down

	return down
}

// removeDownTrack stops forwarding one upstream track to this member.
func (m *Member) removeDownTrack(sourceID, mid string) {
	down := m.downs[sourceID]
	if down == nil {
		return
	}

	send := down.sends[mid]
	if send == nil {
		return
	}

	delete(down.sends, mid)

	for _, transceiver := range down.pc.GetTransceivers() {
		sender := transceiver.Sender()
		if sender == nil || sender.Track() != send.local {
			continue
		}

		err := down.pc.RemoveTrack(sender)
		if err != nil {
			m.fail("track-remove", err)
		}

		break
	}

	down.negotiate(m)
}

// onPeerLeft runs on every remaining member when a peer disconnects.
func (m *Member) onPeerLeft(leftID string) {
	if down := m.downs[leftID]; down != nil {
		delete(m.downs, leftID)

		_ = down.pc.Close()
	}

	if up := m.upstream(); up != nil {
		up.dropViewer(leftID)
	}
}

func (m *Member) teardown() {
	if up := m.upstream(); up != nil {
		up.close()
		m.setUpstream(nil)
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

// UpPeer is a publisher's peer connection; the client offers, the server
// answers, media flows client-to-server.
type UpPeer struct {
	pc     *webrtc.PeerConnection
	member *Member

	// mu guards tracks: the map is mutated on the publisher's task loop
	// but read from subscribers' loops and the REMB ticker. labels and
	// ice stay on the owning loop.
	mu     sync.RWMutex
	tracks map[string]*UpTrack

	labels map[string]string
	ice    iceStash
}

// UpTrack is one forwarded upstream track, keyed by its SDP mid.
type UpTrack struct {
	mid    string
	kind   string
	remote *webrtc.TrackRemote
	pc     *webrtc.PeerConnection

	// extURIs maps the publisher's negotiated RTP header-extension IDs
	// to their URIs, so forwarded packets can be re-numbered per viewer.
	extURIs map[uint8]string

	mu      sync.RWMutex
	viewers map[string]*upViewer
	stop    chan struct{}
}

// upViewer is one viewer of one forwarded track, with the downlink rate
// state derived from that viewer's RTCP feedback.
type upViewer struct {
	local *forwardTrack
	rate  viewerRate
}

// viewerRate tracks a sustainable downlink bitrate for one viewer,
// following Galène's loss-based controller: additive increase while loss
// is low, multiplicative decrease on loss, clamped by whatever REMB the
// viewer itself reports.
type viewerRate struct {
	mu   sync.Mutex
	loss uint64 // bps, AIMD estimate from receiver reports
	remb uint64 // bps cap from the viewer's REMB, 0 = none seen
}

// Galène's loss-controller tuning: receiver-report fraction-lost
// thresholds (in 1/256 units) and the multiplicative rate factors
// between them.
const (
	lowLossFraction  = 5
	highLossFraction = 25
	rateGainNum      = 269
	rateGainDen      = 256
	lossScale        = 512
)

func (vr *viewerRate) updateLoss(fractionLost uint8) {
	vr.mu.Lock()
	defer vr.mu.Unlock()

	rate := vr.loss
	if rate < minViewerBitrate {
		rate = initViewerBitrate
	}

	if fractionLost < lowLossFraction {
		rate = rate * rateGainNum / rateGainDen
	} else if fractionLost > highLossFraction {
		rate = rate * (lossScale - uint64(fractionLost)) / lossScale
		rate = max(rate, minViewerBitrate)
	}

	vr.loss = rate
}

func (vr *viewerRate) setREMB(bitrate float64) {
	if bitrate <= 0 {
		return
	}

	vr.mu.Lock()
	defer vr.mu.Unlock()

	vr.remb = uint64(bitrate)
}

func (vr *viewerRate) max() uint64 {
	vr.mu.Lock()
	defer vr.mu.Unlock()

	rate := vr.loss
	if rate < minViewerBitrate {
		rate = initViewerBitrate
	}

	if vr.remb != 0 && vr.remb < rate {
		rate = vr.remb
	}

	return rate
}

// isVideo reports whether the track carries video (camera or screen);
// everything that is not audio counts, including unknown kinds.
func (ut *UpTrack) isVideo() bool {
	return ut.kind != KindAudio
}

func (ut *UpTrack) startForwarding() {
	ut.stop = make(chan struct{})

	go func() {
		first := true

		for {
			select {
			case <-ut.stop:
				return
			default:
			}

			packet, _, err := ut.remote.ReadRTP()
			if err != nil {
				log.Printf("sfu: forward loop mid=%s kind=%s ended: %v", ut.mid, ut.kind, err)

				return // peer connection closed
			}

			if first {
				first = false

				log.Printf("sfu: first packet mid=%s kind=%s ssrc=%d pt=%d", ut.mid, ut.kind, packet.SSRC, packet.PayloadType)
			}

			ut.mu.RLock()

			viewers := slices.Collect(maps.Values(ut.viewers))

			ut.mu.RUnlock()

			for _, viewer := range viewers {
				writeErr := viewer.local.WriteRTP(packet, ut.extURIs)
				if writeErr != nil {
					log.Printf("forward: %v", writeErr)
				}
			}
		}
	}()
}

func (ut *UpTrack) addViewer(viewerID string, local *forwardTrack) {
	ut.mu.Lock()
	defer ut.mu.Unlock()

	if viewer := ut.viewers[viewerID]; viewer != nil {
		viewer.local = local

		return
	}

	ut.viewers[viewerID] = &upViewer{local: local, rate: viewerRate{mu: sync.Mutex{}, loss: 0, remb: 0}}
}

// minViewerRate returns the smallest sustainable bitrate across this
// track's viewers, or 0 when nobody is watching.
func (ut *UpTrack) minViewerRate() uint64 {
	ut.mu.RLock()
	defer ut.mu.RUnlock()

	var lowest uint64

	for _, viewer := range ut.viewers {
		rate := viewer.rate.max()

		if lowest == 0 || rate < lowest {
			lowest = rate
		}
	}

	return lowest
}

func (ut *UpTrack) setViewerREMB(viewerID string, bitrate float64) {
	ut.mu.RLock()
	viewer := ut.viewers[viewerID]
	ut.mu.RUnlock()

	if viewer != nil {
		viewer.rate.setREMB(bitrate)
	}
}

func (ut *UpTrack) updateViewerLoss(viewerID string, fractionLost uint8) {
	ut.mu.RLock()
	viewer := ut.viewers[viewerID]
	ut.mu.RUnlock()

	if viewer != nil {
		viewer.rate.updateLoss(fractionLost)
	}
}

func (ut *UpTrack) dropViewer(viewerID string) {
	ut.mu.Lock()
	delete(ut.viewers, viewerID)
	ut.mu.Unlock()
}

func (ut *UpTrack) close() {
	if ut.stop != nil {
		close(ut.stop)
	}
}

func (up *UpPeer) hasTracks() bool {
	tracks := up.trackSnapshot()
	for _, t := range tracks {
		if t.isVideo() {
			return true
		}
	}

	return len(tracks) > 0
}

// trackSnapshot returns the registered tracks as a slice. Callers on
// other goroutines must iterate the snapshot, never the live map.
func (up *UpPeer) trackSnapshot() []*UpTrack {
	up.mu.RLock()
	defer up.mu.RUnlock()

	return slices.Collect(maps.Values(up.tracks))
}

func (up *UpPeer) forEachTrack(fn func(*UpTrack)) {
	for _, t := range up.trackSnapshot() {
		fn(t)
	}
}

func (up *UpPeer) videoSSRCs() []uint32 {
	var ssrcs []uint32

	for _, track := range up.trackSnapshot() {
		if track.isVideo() {
			ssrcs = append(ssrcs, uint32(track.remote.SSRC()))
		}
	}

	return ssrcs
}

// adaptiveBitrate picks the REMB ceiling for this publisher: the room cap
// unless a viewer's downlink forces it lower (the minimum across viewers,
// Galène-style), never starving video entirely. Tracks nobody watches do
// not constrain the publisher.
func (up *UpPeer) adaptiveBitrate(ceiling uint64) uint64 {
	rate := ceiling

	for _, track := range up.trackSnapshot() {
		if !track.isVideo() {
			continue
		}

		viewerCap := track.minViewerRate()
		if viewerCap == 0 {
			continue
		}

		if viewerCap < rate {
			rate = viewerCap
		}
	}

	if rate < minPublisherBitrate {
		rate = minPublisherBitrate
	}

	return rate
}

// requestKeyframe sends PLIs for every video track of this publisher.
func (up *UpPeer) requestKeyframe() {
	for _, track := range up.trackSnapshot() {
		if !track.isVideo() {
			continue
		}

		pli := &rtcp.PictureLossIndication{
			SenderSSRC: 1,
			MediaSSRC:  uint32(track.remote.SSRC()),
		}

		err := up.pc.WriteRTCP([]rtcp.Packet{pli})
		if err != nil {
			log.Printf("pli: %v", err)
		}
	}
}

// register records a discovered upstream track. Idempotent per mid;
// called both from the post-SRD scan and from OnTrack.
func (up *UpPeer) register(receiver *webrtc.RTPReceiver, track *webrtc.TrackRemote, labels map[string]string, via string) {
	mid := up.midOf(receiver)
	if mid == "" {
		log.Printf("sfu: register member %.6s via=%s ssrc=%d: no mid, dropped", up.member.ID, via, track.SSRC())

		return
	}

	kind := labels[mid]
	if kind == "" {
		if track.Kind() == webrtc.RTPCodecTypeAudio {
			kind = KindAudio
		} else {
			kind = KindCamera
		}
	}

	upTrack := &UpTrack{
		mid:     mid,
		kind:    kind,
		remote:  track,
		pc:      up.pc,
		extURIs: extensionURIs(receiver),
		viewers: map[string]*upViewer{},
		mu:      sync.RWMutex{},
		stop:    nil,
	}

	if !up.addTrack(mid, upTrack) {
		return
	}

	log.Printf("sfu: register %s member %s via=%s mid=%s kind=%s ssrc=%d", up.member.room.slug, up.member.ID, via, mid, kind, track.SSRC())

	upTrack.startForwarding()
}

// addTrack records an upstream track unless its mid is already taken;
// it reports whether the track was stored.
func (up *UpPeer) addTrack(mid string, upTrack *UpTrack) bool {
	up.mu.Lock()
	defer up.mu.Unlock()

	if _, ok := up.tracks[mid]; ok {
		return false
	}

	up.tracks[mid] = upTrack

	return true
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

		if track := receiver.Track(); track != nil {
			up.register(receiver, track, up.labels, "sync")
		}
	}
}

// pruneInactive tears down upstream tracks whose media section the
// publisher deactivated (screen share stopped). Returns their mids.
func (up *UpPeer) pruneInactive() []string {
	var removed []string

	for _, transceiver := range up.pc.GetTransceivers() {
		mid := transceiver.Mid()
		if !up.trackKnown(mid) {
			continue
		}

		if transceiver.Direction() == webrtc.RTPTransceiverDirectionInactive {
			up.removeTrack(mid)

			removed = append(removed, mid)
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
	kind  string
}

// DownPeer carries one source member's tracks to one viewer. The server
// offers, the viewer answers.
type DownPeer struct {
	sourceID string
	pc       *webrtc.PeerConnection
	sends    map[string]*downSend
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

// watchFeedback relays a viewer's RTCP feedback on one forwarded track
// to the publisher: keyframe requests (PLI or FIR, what a browser sends
// after losing video packets mid-call) trigger upstream keyframes, while
// REMB and receiver-report loss feed the per-viewer rate that caps the
// publisher's bitrate. Without the relay a constrained downlink floods
// into a frozen picture no keyframe can recover. The loop ends when the
// peer connection closes and ReadRTCP fails.
func (dp *DownPeer) watchFeedback(sender *webrtc.RTPSender, viewer *Member, track *UpTrack) {
	if sender == nil {
		return
	}

	go func() {
		var lastForward time.Time

		for {
			packets, _, err := sender.ReadRTCP()
			if err != nil {
				return
			}

			for _, packet := range packets {
				switch feedback := packet.(type) {
				case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
					if time.Since(lastForward) < keyframeRequestInterval {
						continue
					}

					lastForward = time.Now()

					viewer.room.requestKeyframe(dp.sourceID)
				case *rtcp.ReceiverEstimatedMaximumBitrate:
					track.setViewerREMB(viewer.ID, float64(feedback.Bitrate))
				case *rtcp.ReceiverReport:
					for _, report := range feedback.Reports {
						track.updateViewerLoss(viewer.ID, report.FractionLost)
					}
				}
			}
		}
	}()
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
