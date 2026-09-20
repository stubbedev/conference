// Package store persists rooms and authenticated sessions in SQLite.
package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite" // registers the pure-Go SQLite driver
)

// ErrNotFound is returned when a room or session does not exist.
var ErrNotFound = errors.New("store: not found")

// row abstracts over *sql.Row and *sql.Rows for scanning.
type row interface {
	Scan(dest ...any) error
}

// Room is the persisted state of a pre-created room. Rooms are immutable:
// nothing updates a row after CreateRoom except DeleteRoom.
type Room struct {
	Slug       string
	Name       string
	AuthSalt   []byte // nil when the room has no password
	AuthHash   []byte
	KeySalt    []byte
	Keyblob    []byte // room key sealed under the password; nil for open rooms
	OpenKey    []byte // room key in the clear; set for open rooms only
	PrivHash   []byte // SHA-256 of the privileged link token
	MaxMembers int
	CreatedAt  time.Time
}

// RequiresPassword reports whether joining needs a password proof.
func (r *Room) RequiresPassword() bool { return r.AuthHash != nil }

// Session is an authenticated grant to join one room. Tokens are opaque;
// only their SHA-256 is stored, so the database does not leak usable grants.
type Session struct {
	Room      string
	Priv      bool
	ExpiresAt time.Time
}

// Store is a SQLite-backed repository of rooms and sessions.
type Store struct{ db *sql.DB }

const schema = `
CREATE TABLE IF NOT EXISTS meta (
	key   TEXT PRIMARY KEY,
	value BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
	slug        TEXT PRIMARY KEY,
	name        TEXT NOT NULL DEFAULT '',
	auth_salt   BLOB,
	auth_hash   BLOB,
	key_salt    BLOB,
	keyblob     BLOB,
	open_key    BLOB,
	priv_hash   BLOB NOT NULL,
	max_members INTEGER NOT NULL DEFAULT 0,
	created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	id         TEXT PRIMARY KEY,
	room       TEXT NOT NULL,
	priv       INTEGER NOT NULL DEFAULT 0,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
`

// Open opens (creating if needed) the database at path.
func Open(path string) (*Store, error) {
	database, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("store: open: %w", err)
	}

	// modernc.org/sqlite serializes writers; one connection avoids
	// SQLITE_BUSY entirely at this scale.
	database.SetMaxOpenConns(1)

	for _, pragma := range []string{
		"PRAGMA journal_mode=WAL",
		"PRAGMA busy_timeout=5000",
		"PRAGMA synchronous=NORMAL",
	} {
		_, err := database.ExecContext(context.Background(), pragma)
		if err != nil {
			_ = database.Close()

			return nil, fmt.Errorf("store: pragma: %w", err)
		}
	}

	_, err = database.ExecContext(context.Background(), schema)
	if err != nil {
		_ = database.Close()

		return nil, fmt.Errorf("store: schema: %w", err)
	}

	return &Store{db: database}, nil
}

// Close closes the underlying database.
func (s *Store) Close() error {
	err := s.db.Close()
	if err != nil {
		return fmt.Errorf("store: close: %w", err)
	}

	return nil
}

// CreateRoom inserts a new room. The slug must not exist yet.
func (s *Store) CreateRoom(ctx context.Context, r Room) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO rooms
		(slug, name, auth_salt, auth_hash, key_salt, keyblob, open_key, priv_hash, max_members, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.Slug, r.Name, r.AuthSalt, r.AuthHash, r.KeySalt, r.Keyblob,
		r.OpenKey, r.PrivHash, r.MaxMembers, r.CreatedAt.Unix())
	if err != nil {
		return fmt.Errorf("store: create room: %w", err)
	}

	return nil
}

func scanRoom(scanner row) (*Room, error) {
	var r Room

	var created int64

	var maxMembers int

	err := scanner.Scan(&r.Slug, &r.Name, &r.AuthSalt, &r.AuthHash, &r.KeySalt,
		&r.Keyblob, &r.OpenKey, &r.PrivHash, &maxMembers, &created)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}

	if err != nil {
		return nil, fmt.Errorf("store: scan room: %w", err)
	}

	r.MaxMembers = maxMembers
	r.CreatedAt = time.Unix(created, 0)

	return &r, nil
}

const roomColumns = `slug, name, auth_salt, auth_hash, key_salt, keyblob, open_key, priv_hash, max_members, created_at`

// GetRoom returns the room with the given slug.
func (s *Store) GetRoom(ctx context.Context, slug string) (*Room, error) {
	return scanRoom(s.db.QueryRowContext(ctx, `SELECT `+roomColumns+` FROM rooms WHERE slug = ?`, slug))
}

// ListRooms returns every room, oldest first.
func (s *Store) ListRooms(ctx context.Context) ([]*Room, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+roomColumns+` FROM rooms ORDER BY created_at`)
	if err != nil {
		return nil, fmt.Errorf("store: list rooms: %w", err)
	}

	defer func() { _ = rows.Close() }()

	var out []*Room

	for rows.Next() {
		r, err := scanRoom(rows)
		if err != nil {
			return nil, err
		}

		out = append(out, r)
	}

	err = rows.Err()
	if err != nil {
		return nil, fmt.Errorf("store: list rooms: %w", err)
	}

	return out, nil
}

// DeleteRoom removes a room and all of its session grants.
func (s *Store) DeleteRoom(ctx context.Context, slug string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM rooms WHERE slug = ?`, slug)
	if err != nil {
		return fmt.Errorf("store: delete room: %w", err)
	}

	deleted, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("store: delete room: %w", err)
	}

	if deleted == 0 {
		return ErrNotFound
	}

	_, err = s.db.ExecContext(ctx, `DELETE FROM sessions WHERE room = ?`, slug)
	if err != nil {
		return fmt.Errorf("store: delete sessions: %w", err)
	}

	return nil
}

// StaleRooms returns the slugs of rooms created before cutoff.
func (s *Store) StaleRooms(ctx context.Context, cutoff time.Time) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT slug FROM rooms WHERE created_at < ?`, cutoff.Unix())
	if err != nil {
		return nil, fmt.Errorf("store: stale rooms: %w", err)
	}

	defer func() { _ = rows.Close() }()

	var slugs []string

	for rows.Next() {
		var slug string

		err = rows.Scan(&slug)
		if err != nil {
			return nil, fmt.Errorf("store: stale rooms: %w", err)
		}

		slugs = append(slugs, slug)
	}

	err = rows.Err()
	if err != nil {
		return nil, fmt.Errorf("store: stale rooms: %w", err)
	}

	return slugs, nil
}

// PurgeExpiredSessions deletes session grants past their expiry.
func (s *Store) PurgeExpiredSessions(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at < ?`, time.Now().Unix())
	if err != nil {
		return fmt.Errorf("store: purge sessions: %w", err)
	}

	return nil
}

// CreateSession stores a session grant for the given opaque token.
func (s *Store) CreateSession(ctx context.Context, token, room string, priv bool, ttl time.Duration) error {
	sum := sha256.Sum256([]byte(token))
	now := time.Now()

	// Opportunistically purge expired grants.
	_, err := s.db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at < ?`, now.Unix())
	if err != nil {
		return fmt.Errorf("store: purge sessions: %w", err)
	}

	_, err = s.db.ExecContext(ctx, `INSERT INTO sessions (id, room, priv, expires_at, created_at)
		VALUES (?, ?, ?, ?, ?)`,
		hex.EncodeToString(sum[:]), room, boolInt(priv), now.Add(ttl).Unix(), now.Unix())
	if err != nil {
		return fmt.Errorf("store: create session: %w", err)
	}

	return nil
}

// GetSession validates a session token and returns its grant. Expired
// and unknown tokens are indistinguishable.
func (s *Store) GetSession(ctx context.Context, token string) (*Session, error) {
	sum := sha256.Sum256([]byte(token))

	var sess Session

	var priv int

	var exp int64

	err := s.db.QueryRowContext(ctx, `SELECT room, priv, expires_at FROM sessions WHERE id = ?`,
		hex.EncodeToString(sum[:])).Scan(&sess.Room, &priv, &exp)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}

	if err != nil {
		return nil, fmt.Errorf("store: get session: %w", err)
	}

	sess.Priv = priv != 0
	sess.ExpiresAt = time.Unix(exp, 0)

	if time.Now().After(sess.ExpiresAt) {
		return nil, ErrNotFound
	}

	return &sess, nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}

	return 0
}
