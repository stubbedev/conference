package store_test

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/stubbe/conference/internal/store"
)

const testSlug = "abc-def-ghi"

func openTest(t *testing.T) *store.Store {
	t.Helper()

	storage, err := store.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}

	t.Cleanup(func() { _ = storage.Close() })

	return storage
}

func passwordRoom(slug, privHash string) store.Room {
	return store.Room{
		Slug:     slug,
		Name:     "",
		AuthSalt: nil, AuthHash: nil, KeySalt: nil, Keyblob: nil,
		OpenKey:  nil,
		PrivHash: []byte(privHash),
		E2EE:     false, MaxMembers: 0, CreatedAt: time.Time{},
	}
}

func TestRoomRoundTrip(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	storage := openTest(t)
	created := time.Now().Truncate(time.Second)

	err := storage.CreateRoom(ctx, store.Room{
		Slug:     testSlug,
		Name:     "Standup",
		AuthSalt: []byte("saltsalt"), AuthHash: []byte("hash"),
		KeySalt: []byte("ksalt"), Keyblob: []byte("blob"),
		OpenKey: nil, PrivHash: []byte("priv"),
		E2EE: true, MaxMembers: 5, CreatedAt: created,
	})
	if err != nil {
		t.Fatal(err)
	}

	got, err := storage.GetRoom(ctx, testSlug)
	if err != nil {
		t.Fatal(err)
	}

	if got.Name != "Standup" || !got.RequiresPassword() || !got.E2EE || got.MaxMembers != 5 {
		t.Errorf("unexpected room: %+v", got)
	}

	_, err = storage.GetRoom(ctx, "nope")
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("missing room: err = %v, want ErrNotFound", err)
	}

	err = storage.CreateRoom(ctx, passwordRoom(testSlug, "x"))
	if err == nil {
		t.Error("duplicate slug accepted")
	}
}

func TestDeleteRoom(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	storage := openTest(t)

	err := storage.CreateRoom(ctx, passwordRoom(testSlug, "p"))
	if err != nil {
		t.Fatal(err)
	}

	err = storage.CreateSession(ctx, "tok", testSlug, false, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	err = storage.DeleteRoom(ctx, testSlug)
	if err != nil {
		t.Fatal(err)
	}

	_, err = storage.GetRoom(ctx, testSlug)
	if !errors.Is(err, store.ErrNotFound) {
		t.Error("room still present after delete")
	}

	_, err = storage.GetSession(ctx, "tok")
	if !errors.Is(err, store.ErrNotFound) {
		t.Error("sessions outliving their room")
	}

	err = storage.DeleteRoom(ctx, testSlug)
	if !errors.Is(err, store.ErrNotFound) {
		t.Errorf("double delete: err = %v", err)
	}
}

func TestListRooms(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	storage := openTest(t)

	for _, slug := range []string{"b-slug", "a-slug", "c-slug"} {
		err := storage.CreateRoom(ctx, passwordRoom(slug, "p"))
		if err != nil {
			t.Fatal(err)
		}
	}

	rooms, err := storage.ListRooms(ctx)
	if err != nil {
		t.Fatal(err)
	}

	if len(rooms) != 3 {
		t.Fatalf("len = %d, want 3", len(rooms))
	}

	// Insertion order, not alphabetical.
	if rooms[0].Slug != "b-slug" || rooms[1].Slug != "a-slug" {
		t.Errorf("unexpected order: %q, %q", rooms[0].Slug, rooms[1].Slug)
	}
}

func TestSessions(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	storage := openTest(t)

	err := storage.CreateSession(ctx, "tok1", "r", true, time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	sess, err := storage.GetSession(ctx, "tok1")
	if err != nil {
		t.Fatal(err)
	}

	if sess.Room != "r" || !sess.Priv {
		t.Errorf("unexpected session: %+v", sess)
	}

	err = storage.CreateSession(ctx, "tok3", "r", true, 24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}

	extended, err := storage.GetSession(ctx, "tok3")
	if err != nil {
		t.Fatal(err)
	}

	if extended.ExpiresAt.Before(time.Now()) {
		t.Error("grant expiry drifted")
	}
}

func TestSessionExpiry(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	storage := openTest(t)

	err := storage.CreateSession(ctx, "tok2", "r", false, -time.Minute)
	if err != nil {
		t.Fatal(err)
	}

	_, err = storage.GetSession(ctx, "tok2")
	if !errors.Is(err, store.ErrNotFound) {
		t.Error("expired session still valid")
	}

	_, err = storage.GetSession(ctx, "unknown")
	if !errors.Is(err, store.ErrNotFound) {
		t.Error("unknown token accepted")
	}
}
