// Package api serves the management REST API: room creation, public room
// metadata, join authorization (sessions), and operator endpoints.
package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/stubbe/conference/internal/config"
	"github.com/stubbe/conference/internal/recvbuf"
	"github.com/stubbe/conference/internal/roomcrypt"
	"github.com/stubbe/conference/internal/sfu"
	"github.com/stubbe/conference/internal/speech/service"
	"github.com/stubbe/conference/internal/store"
)

// Rate-limit, size, and validation tuning.
const (
	authLimiterCapacity   = 10
	authLimiterRefill     = 0.2
	createLimiterCapacity = 10
	createLimiterRefill   = 1.0 / 60
	hoursPerDay           = 24
	maxCreateBodyBytes    = 32 << 10
	maxAuthBodyBytes      = 8 << 10
	limiterMaxEntries     = 4096
	slugRetries           = 5
	maxRoomNameLen        = 80
	maxPasswordLen        = 128
	maxRoomMembersCap     = 256
)

// Server holds the API dependencies.
type Server struct {
	Store *store.Store
	Hub   *sfu.Hub
	Cfg   *config.Config

	// SlackClient posts the Slack slash command's follow-up messages.
	SlackClient *http.Client

	translation   service.Status
	sockets       *recvbuf.Sizer
	authLimiter   *limiter
	createLimiter *limiter
}

// New creates an API server around the shared store, hub, and config,
// reporting translation as whether live translation can run and sockets
// as what the kernel granted the media sockets.
func New(
	storage *store.Store,
	hub *sfu.Hub,
	cfg *config.Config,
	translation service.Status,
	sockets *recvbuf.Sizer,
) *Server {
	return &Server{
		Store:         storage,
		Hub:           hub,
		Cfg:           cfg,
		SlackClient:   &http.Client{Timeout: slackFollowUpTimeout},
		translation:   translation,
		sockets:       sockets,
		authLimiter:   newLimiter(authLimiterCapacity, authLimiterRefill),
		createLimiter: newLimiter(createLimiterCapacity, createLimiterRefill),
	}
}

// Routes registers API endpoints on mux.
func (s *Server) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/healthz", s.health)
	mux.HandleFunc("GET /api/config", s.getConfig)
	mux.HandleFunc("POST /api/rooms", s.createRoom)
	mux.HandleFunc("GET /api/rooms", s.listRooms)
	mux.HandleFunc("GET /api/rooms/{slug}", s.roomInfo)
	mux.HandleFunc("DELETE /api/rooms/{slug}", s.deleteRoom)
	mux.HandleFunc("POST /api/rooms/{slug}/auth", s.auth)

	if s.Cfg.SlackSigningSecret != "" {
		mux.HandleFunc("POST /api/slack/meet", s.slackMeet)
	}

	mux.HandleFunc("/api/", func(w http.ResponseWriter, _ *http.Request) {
		writeError(w, http.StatusNotFound, "not-found", "No such API endpoint.")
	})
}

// healthResponse is the server's account of itself: that it answers, and
// whether the kernel gave its media sockets the receive buffer they ask
// for, which an operator otherwise only learns from the log.
type healthResponse struct {
	OK            bool           `json:"ok"`
	ReceiveBuffer recvbuf.Status `json:"receiveBuffer"`
}

func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, healthResponse{OK: true, ReceiveBuffer: s.sockets.Status()})
}

type configResponse struct {
	CreateAuthRequired  bool `json:"createAuthRequired"`
	SessionLifetimeDays int  `json:"sessionLifetimeDays"`
	JoinOnly            bool `json:"joinOnly"`
	// Translation is shown either way: unavailable, the web app greys it
	// out with the reason.
	Translation service.Status `json:"translation"`
}

func (s *Server) getConfig(w http.ResponseWriter, r *http.Request) {
	open := s.openCreate(r)

	writeJSON(w, http.StatusOK, configResponse{
		CreateAuthRequired:  len(s.Cfg.APIKeys) > 0 && !open,
		SessionLifetimeDays: int(s.Cfg.SessionTTL / (hoursPerDay * time.Hour)),
		JoinOnly:            s.Cfg.JoinOnly && !open,
		Translation:         s.translation,
	})
}

type createRoomRequest struct {
	Name       string `json:"name"`
	Password   string `json:"password"`
	MaxMembers int    `json:"maxMembers"`
}

type createRoomResponse struct {
	Slug       string `json:"slug"`
	Name       string `json:"name"`
	RoomKey    string `json:"roomKey"`
	PrivToken  string `json:"privToken"`
	PrivPath   string `json:"privPath"`
	PrivURL    string `json:"privUrl,omitempty"`
	ShortPath  string `json:"shortPath"`
	ShortURL   string `json:"shortUrl,omitempty"`
	BaseURL    string `json:"baseUrl,omitempty"`
	MaxMembers int    `json:"maxMembers"`
}

// createRoom makes a new room. Rooms are immutable afterwards; this is
// the only moment the room key and privileged token are ever revealed.
// Hosts listed in OpenCreateHosts are exempt from the key check, and
// creation without a valid key is rate limited per client.
func (s *Server) createRoom(w http.ResponseWriter, r *http.Request) {
	keyed := s.presentsValidKey(r)

	if !keyed && len(s.Cfg.APIKeys) > 0 && !s.openCreate(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Room creation requires a valid API key.")

		return
	}

	if !keyed && !s.createLimiter.allow(s.clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "rate-limited", "Too many rooms created; try again later.")

		return
	}

	req, ok := parseCreateRoom(w, r)
	if !ok {
		return
	}

	created, err := s.newRoom(r.Context(), req, s.Cfg.OriginFor(r.Host))
	if err != nil {
		log.Printf("api: create room: %v", err)
		writeError(w, http.StatusInternalServerError, "internal", "Could not create the room.")

		return
	}

	writeJSON(w, http.StatusCreated, created)
}

// newRoom persists a room for req under a fresh slug and returns the
// one-time response carrying its key and its links on origin.
func (s *Server) newRoom(ctx context.Context, req createRoomRequest, origin string) (createRoomResponse, error) {
	key := roomcrypt.NewKey()
	privToken := roomcrypt.NewToken()

	room, err := buildRoom(req, key, privToken)
	if err != nil {
		return createRoomResponse{}, err
	}

	err = s.insertWithFreshSlug(ctx, &room)
	if err != nil {
		return createRoomResponse{}, err
	}

	roomKey := roomcrypt.B64(key)

	return createRoomResponse{
		Slug:       room.Slug,
		Name:       room.Name,
		RoomKey:    roomKey,
		PrivToken:  privToken,
		PrivPath:   "/r/" + room.Slug + "?p=" + privToken,
		PrivURL:    joinURL(origin, "/r/"+room.Slug+"?p="+privToken+"#k="+roomKey),
		ShortPath:  "/r/" + room.Slug,
		ShortURL:   joinURL(origin, "/r/"+room.Slug),
		BaseURL:    origin,
		MaxMembers: room.MaxMembers,
	}, nil
}

// parseCreateRoom decodes and validates the creation request body.
func parseCreateRoom(w http.ResponseWriter, r *http.Request) (createRoomRequest, bool) {
	var req createRoomRequest

	err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxCreateBodyBytes)).Decode(&req)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad-request", "Invalid JSON body.")

		return req, false
	}

	if len(req.Name) > maxRoomNameLen || len(req.Password) > maxPasswordLen {
		writeError(w, http.StatusBadRequest, "bad-request", "Name or password too long.")

		return req, false
	}

	if req.MaxMembers < 0 || req.MaxMembers > maxRoomMembersCap {
		writeError(w, http.StatusBadRequest, "bad-request", "maxMembers out of range.")

		return req, false
	}

	return req, true
}

// buildRoom fills the persisted room record, sealing the room key under
// the password when one is set.
func buildRoom(req createRoomRequest, key []byte, privToken string) (store.Room, error) {
	room := store.Room{
		Slug:       "",
		Name:       req.Name,
		AuthSalt:   nil,
		AuthHash:   nil,
		KeySalt:    nil,
		Keyblob:    nil,
		OpenKey:    nil,
		PrivHash:   roomcrypt.HashToken(privToken),
		MaxMembers: req.MaxMembers,
		CreatedAt:  time.Now(),
	}

	if req.Password == "" {
		// Keyless room: the server must be able to hand the key to
		// joiners, so it is stored. Password rooms are server-blind.
		room.OpenKey = key

		return room, nil
	}

	authSalt, authHash, keySalt, keyblob, err := roomcrypt.NewPasswordMaterials(key, req.Password)
	if err != nil {
		return store.Room{}, fmt.Errorf("api: seal room key: %w", err)
	}

	room.AuthSalt = authSalt
	room.AuthHash = authHash
	room.KeySalt = keySalt
	room.Keyblob = keyblob

	return room, nil
}

// insertWithFreshSlug inserts room under a fresh slug, retrying on the
// (unlikely) collision.
func (s *Server) insertWithFreshSlug(ctx context.Context, room *store.Room) error {
	var err error

	for range slugRetries {
		room.Slug = roomcrypt.NewSlug()

		err = s.Store.CreateRoom(ctx, *room)
		if err == nil {
			return nil
		}
	}

	return fmt.Errorf("allocate slug after %d attempts: %w", slugRetries, err)
}

type roomInfoResponse struct {
	Slug             string `json:"slug"`
	Name             string `json:"name"`
	RequiresPassword bool   `json:"requiresPassword"`
	Members          int    `json:"members"`
	MaxMembers       int    `json:"maxMembers"`
	AuthSalt         string `json:"authSalt,omitempty"`
	KeySalt          string `json:"keySalt,omitempty"`
}

func (s *Server) roomInfo(w http.ResponseWriter, r *http.Request) {
	room, ok := s.room(w, r)
	if !ok {
		return
	}

	resp := roomInfoResponse{
		Slug:             room.Slug,
		Name:             room.Name,
		RequiresPassword: room.RequiresPassword(),
		Members:          s.Hub.LiveCount(room.Slug),
		MaxMembers:       room.MaxMembers,
		AuthSalt:         "",
		KeySalt:          "",
	}

	if room.RequiresPassword() {
		resp.AuthSalt = roomcrypt.B64(room.AuthSalt)
		resp.KeySalt = roomcrypt.B64(room.KeySalt)
	}

	writeJSON(w, http.StatusOK, resp)
}

type authRequest struct {
	Proof string `json:"proof"`
	Token string `json:"token"`
}

type authResponse struct {
	Session string `json:"session"`
	Priv    bool   `json:"priv"`
	Key     string `json:"key,omitempty"`     // open rooms: the room key itself
	Keyblob string `json:"keyblob,omitempty"` // password rooms: sealed room key
	KeySalt string `json:"keySalt,omitempty"`
}

// auth grants a long-lived join session, by privileged link token,
// open-room admission, or password proof.
func (s *Server) auth(w http.ResponseWriter, r *http.Request) {
	room, ok := s.room(w, r)
	if !ok {
		return
	}

	var req authRequest

	err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxAuthBodyBytes)).Decode(&req)
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad-request", "Invalid JSON body.")

		return
	}

	switch {
	case req.Token != "":
		s.authWithToken(w, r, room, req.Token)
	case !room.RequiresPassword():
		s.authOpenRoom(w, r, room)
	default:
		s.authWithPassword(w, r, room, req.Proof)
	}
}

// authWithToken grants a privileged session for a valid link token.
func (s *Server) authWithToken(w http.ResponseWriter, r *http.Request, room *store.Room, token string) {
	if !s.authLimiter.allow(s.clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "rate-limited", "Too many attempts; try again later.")

		return
	}

	if subtle.ConstantTimeCompare(roomcrypt.HashToken(token), room.PrivHash) != 1 {
		writeError(w, http.StatusUnauthorized, "bad-token", "Invalid room token.")

		return
	}

	sess := roomcrypt.NewToken()

	err := s.Store.CreateSession(r.Context(), sess, room.Slug, true, s.Cfg.SessionTTL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "Could not create session.")

		return
	}

	writeJSON(w, http.StatusOK, authResponse{
		Session: sess,
		Priv:    true,
		Key:     "",
		Keyblob: "",
		KeySalt: "",
	})
}

// authOpenRoom grants an unprivileged session and returns the room key
// itself; keyless rooms cannot be server-blind.
func (s *Server) authOpenRoom(w http.ResponseWriter, r *http.Request, room *store.Room) {
	sess := roomcrypt.NewToken()

	err := s.Store.CreateSession(r.Context(), sess, room.Slug, false, s.Cfg.SessionTTL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "Could not create session.")

		return
	}

	writeJSON(w, http.StatusOK, authResponse{
		Session: sess,
		Priv:    false,
		Key:     roomcrypt.B64(room.OpenKey),
		Keyblob: "",
		KeySalt: "",
	})
}

// authWithPassword verifies a PBKDF2 proof and returns the room key
// sealed under the password; the raw password never reaches the server.
func (s *Server) authWithPassword(w http.ResponseWriter, r *http.Request, room *store.Room, proofB64 string) {
	if proofB64 == "" {
		writeError(w, http.StatusBadRequest, "password-required", "This room requires a password.")

		return
	}

	if !s.authLimiter.allow(s.clientIP(r)) {
		writeError(w, http.StatusTooManyRequests, "rate-limited", "Too many attempts; try again later.")

		return
	}

	proof, err := roomcrypt.UnB64(proofB64)
	if err != nil || !roomcrypt.VerifyProof(proof, room.AuthHash) {
		writeError(w, http.StatusUnauthorized, "bad-password", "Wrong password.")

		return
	}

	sess := roomcrypt.NewToken()

	err = s.Store.CreateSession(r.Context(), sess, room.Slug, false, s.Cfg.SessionTTL)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "Could not create session.")

		return
	}

	writeJSON(w, http.StatusOK, authResponse{
		Session: sess,
		Priv:    false,
		Key:     "",
		Keyblob: roomcrypt.B64(room.Keyblob),
		KeySalt: roomcrypt.B64(room.KeySalt),
	})
}

func (s *Server) deleteRoom(w http.ResponseWriter, r *http.Request) {
	if !s.checkAPIKey(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Room deletion requires a valid API key.")

		return
	}

	slug := r.PathValue("slug")

	_, err := s.Store.GetRoom(r.Context(), slug)
	if err != nil {
		writeError(w, http.StatusNotFound, "not-found", "No such room.")

		return
	}

	err = s.Store.DeleteRoom(r.Context(), slug)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "Could not delete room.")

		return
	}

	s.Hub.CloseRoom(slug)

	w.WriteHeader(http.StatusNoContent)
}

type adminRoom struct {
	Slug             string `json:"slug"`
	Name             string `json:"name"`
	RequiresPassword bool   `json:"requiresPassword"`
	MaxMembers       int    `json:"maxMembers"`
	CreatedAt        string `json:"createdAt"`
	Live             int    `json:"live"`
}

func (s *Server) listRooms(w http.ResponseWriter, r *http.Request) {
	if !s.checkAPIKey(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized", "Listing rooms requires a valid API key.")

		return
	}

	rooms, err := s.Store.ListRooms(r.Context())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "Could not list rooms.")

		return
	}

	out := make([]adminRoom, 0, len(rooms))

	for _, room := range rooms {
		out = append(out, adminRoom{
			Slug:             room.Slug,
			Name:             room.Name,
			RequiresPassword: room.RequiresPassword(),
			MaxMembers:       room.MaxMembers,
			CreatedAt:        room.CreatedAt.UTC().Format(time.RFC3339),
			Live:             s.Hub.LiveCount(room.Slug),
		})
	}

	writeJSON(w, http.StatusOK, out)
}

// room looks up the room from the request path, writing the error
// response itself. The bool is false when the request is already handled.
func (s *Server) room(w http.ResponseWriter, r *http.Request) (*store.Room, bool) {
	room, err := s.Store.GetRoom(r.Context(), r.PathValue("slug"))
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			writeError(w, http.StatusNotFound, "not-found", "No such room.")
		} else {
			writeError(w, http.StatusInternalServerError, "internal", "Lookup failed.")
		}

		return nil, false
	}

	return room, true
}

// checkAPIKey validates the operator key when configured. With no keys
// configured, creation is open (single-operator self-hosting).
func (s *Server) checkAPIKey(r *http.Request) bool {
	return len(s.Cfg.APIKeys) == 0 || s.presentsValidKey(r)
}

// presentsValidKey reports whether the request carries one of the
// configured operator keys; always false when none are configured.
func (s *Server) presentsValidKey(r *http.Request) bool {
	key := r.Header.Get("Authorization")

	key = strings.TrimPrefix(key, "Bearer ")

	if key == "" {
		key = r.Header.Get("X-Api-Key")
	}

	for _, candidate := range s.Cfg.APIKeys {
		if subtle.ConstantTimeCompare([]byte(candidate), []byte(key)) == 1 {
			return true
		}
	}

	return false
}

// requestHost returns the lowercased Host header without its port.
func requestHost(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.Host)
	if err != nil {
		host = r.Host
	}

	return strings.ToLower(host)
}

// openCreate reports whether the request's host is exempt from the API
// key requirement and the join-only landing page.
func (s *Server) openCreate(r *http.Request) bool {
	return slices.Contains(s.Cfg.OpenCreateHosts, requestHost(r))
}

// clientIP identifies the client for rate limiting: the TCP peer, or,
// when the peer is a trusted proxy, the rightmost X-Forwarded-For hop
// that is not itself a trusted proxy. Hops left of that are written by
// the client and never trusted.
func (s *Server) clientIP(r *http.Request) string {
	peer, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}

	client := peer.Addr().Unmap()

	hops := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")

	for i := len(hops) - 1; i >= 0 && s.trustedProxy(client); i-- {
		hop, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			break
		}

		client = hop.Unmap()
	}

	return client.String()
}

func (s *Server) trustedProxy(addr netip.Addr) bool {
	return slices.ContainsFunc(s.Cfg.TrustedProxies, func(prefix netip.Prefix) bool {
		return prefix.Contains(addr)
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)

	err := json.NewEncoder(w).Encode(body)
	if err != nil {
		log.Printf("api: encode response: %v", err)
	}
}

// joinURL prefixes an absolute link when a public origin is
// configured; an empty result means the caller builds its own.
func joinURL(base, path string) string {
	if base == "" {
		return ""
	}

	return base + path
}

func writeError(w http.ResponseWriter, status int, code, text string) {
	writeJSON(w, status, map[string]string{"error": code, "message": text})
}

// limiter is a minimal token bucket keyed by client IP, used to slow
// password and token brute forcing.
type limiter struct {
	mu       sync.Mutex
	buckets  map[string]*bucket
	capacity float64
	refill   float64 // tokens per second
}

type bucket struct {
	tokens float64
	last   time.Time
}

func newLimiter(capacity, refill float64) *limiter {
	return &limiter{
		mu:       sync.Mutex{},
		buckets:  map[string]*bucket{},
		capacity: capacity,
		refill:   refill,
	}
}

func (l *limiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	if len(l.buckets) > limiterMaxEntries {
		for entry, state := range l.buckets {
			if time.Since(state.last) > time.Hour {
				delete(l.buckets, entry)
			}
		}
	}

	entry, ok := l.buckets[key]
	if !ok {
		l.buckets[key] = &bucket{tokens: l.capacity - 1, last: time.Now()}

		return true
	}

	now := time.Now()

	entry.tokens = min(l.capacity, entry.tokens+now.Sub(entry.last).Seconds()*l.refill)
	entry.last = now

	if entry.tokens < 1 {
		return false
	}

	entry.tokens--

	return true
}
