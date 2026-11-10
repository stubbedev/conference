package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"log"
	"maps"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// partialDir holds the downloads under way, inside the model
	// directory so each renames into place on the same file system. Its
	// name is hidden, which no manifest path may be.
	partialDir = ".partial"

	immutable   = "public, max-age=31536000, immutable"
	streamChunk = 256 << 10
	dirMode     = 0o750
)

var (
	errCacheLimit   = errors.New("is smaller than a file the browsers load")
	errCacheFull    = errors.New("every cached file is in use, so there is no room for another")
	errCacheEntry   = errors.New("is not a regular file")
	errDownloadSize = errors.New("the hub sent a size other than the manifest's")
	errDigest       = errors.New("the hub sent bytes that do not match the manifest's digest")
)

// modelCache serves the model files the manifest names. A file it has
// is served from the model directory; one it lacks is fetched from the
// hub at its commit, streamed to every browser that asks while it
// downloads, and kept only once it is whole and matches the manifest.
// It holds at most limit bytes, and makes room by deleting the file
// used longest ago that no browser is reading.
type modelCache struct {
	dir   string
	files manifest
	hub   hub
	limit int64

	mu      sync.Mutex
	cached  map[string]*cachedFile
	fetches map[string]*download
	used    int64
	clock   uint64
}

type cachedFile struct {
	size    int64
	used    uint64
	readers int
}

// newModelCache takes over dir as the cache of files: a file there of
// the size the manifest gives is kept, one of another size is deleted,
// and downloads a stopped server left are cleared.
func newModelCache(dir string, files manifest, limit int64, source hub) (*modelCache, error) {
	if name, size := files.largest(); limit < size {
		return nil, fmt.Errorf("%s=%d %w: %s, %d bytes", envModelCacheMax, limit, errCacheLimit, name, size)
	}

	partial := filepath.Join(dir, partialDir)

	err := os.RemoveAll(partial)
	if err != nil {
		return nil, fmt.Errorf("clear the partial downloads in %s: %w", partial, err)
	}

	err = os.MkdirAll(partial, dirMode)
	if err != nil {
		return nil, fmt.Errorf("the model directory %s must be writable: %w", dir, err)
	}

	cache := &modelCache{
		dir:     dir,
		files:   files,
		hub:     source,
		limit:   limit,
		mu:      sync.Mutex{},
		cached:  map[string]*cachedFile{},
		fetches: map[string]*download{},
		used:    0,
		clock:   0,
	}

	err = cache.adopt()
	if err != nil {
		return nil, err
	}

	log.Printf("speech models: %d of %d files cached in %s, %d of at most %d bytes", len(cache.cached), len(files), dir, cache.used, limit)

	return cache, nil
}

// ServeHTTP serves a file the manifest lists, from the cache or else
// from the hub; any other path is not found.
func (c *modelCache) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, http.StatusText(http.StatusMethodNotAllowed), http.StatusMethodNotAllowed)

		return
	}

	name, ok := strings.CutPrefix(r.URL.Path, ModelsPath)

	file, listed := c.files[name]
	if !ok || !listed {
		http.NotFound(w, r)

		return
	}

	header := w.Header()
	header.Set("Cache-Control", immutable)
	header.Set("ETag", file.etag())
	header.Set("Content-Type", modelContentType(name))

	opened, release, err := c.hit(name)
	if err != nil {
		log.Printf("speech models: %v", err)
		http.Error(w, "the model file could not be read", http.StatusInternalServerError)

		return
	}

	if opened != nil {
		defer release()

		http.ServeContent(w, r, name, time.Time{}, opened)

		return
	}

	if r.Method == http.MethodHead {
		header.Set("Content-Length", strconv.FormatInt(file.size, 10))
		w.WriteHeader(http.StatusOK)

		return
	}

	c.stream(w, r, name, file)
}

// adopt takes the files already in the model directory into the cache,
// the one changed longest ago as the least recently used, and deletes
// what does not fit.
func (c *modelCache) adopt() error {
	type found struct {
		name    string
		changed time.Time
	}

	var present []found

	for _, name := range slices.Sorted(maps.Keys(c.files)) {
		target := c.path(name)

		info, err := os.Lstat(target)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}

		if err != nil {
			return fmt.Errorf("look at the cached %s: %w", target, err)
		}

		if !info.Mode().IsRegular() {
			return fmt.Errorf("the cached %s %w", target, errCacheEntry)
		}

		if info.Size() != c.files[name].size {
			log.Printf("speech models: deleting %s, %d bytes where the manifest gives %d", target, info.Size(), c.files[name].size)

			err = os.Remove(target)
			if err != nil {
				return fmt.Errorf("delete the outdated %s: %w", target, err)
			}

			continue
		}

		present = append(present, found{name: name, changed: info.ModTime()})
	}

	slices.SortStableFunc(present, func(a, b found) int { return a.changed.Compare(b.changed) })

	c.mu.Lock()
	defer c.mu.Unlock()

	for _, file := range present {
		c.clock++
		c.cached[file.name] = &cachedFile{size: c.files[file.name].size, used: c.clock, readers: 0}
		c.used += c.files[file.name].size
	}

	return c.evict(0)
}

func (c *modelCache) path(name string) string {
	return filepath.Join(c.dir, filepath.FromSlash(name))
}

// evict deletes the least recently used files no browser is reading
// until room more bytes fit. The caller holds c.mu.
func (c *modelCache) evict(room int64) error {
	for c.used+room > c.limit {
		victim := ""

		for name, file := range c.cached {
			if file.readers > 0 {
				continue
			}

			if victim == "" || file.used < c.cached[victim].used {
				victim = name
			}
		}

		if victim == "" {
			return fmt.Errorf("%w: %d of %d bytes used, %d more wanted", errCacheFull, c.used, c.limit, room)
		}

		err := os.Remove(c.path(victim))
		if err != nil && !errors.Is(err, fs.ErrNotExist) {
			return fmt.Errorf("evict %s: %w", c.path(victim), err)
		}

		log.Printf("speech models: evicted %s, used least recently", victim)

		c.used -= c.cached[victim].size
		delete(c.cached, victim)
	}

	return nil
}

func modelContentType(name string) string {
	if path.Ext(name) == ".json" {
		return "application/json"
	}

	return "application/octet-stream"
}

// hit opens the cached file name for reading, kept from eviction until
// release is called; a nil file means it is not cached.
func (c *modelCache) hit(name string) (*os.File, func(), error) {
	c.mu.Lock()

	entry, ok := c.cached[name]
	if !ok {
		c.mu.Unlock()

		return nil, nil, nil
	}

	c.clock++
	entry.used = c.clock
	entry.readers++
	c.mu.Unlock()

	release := func() {
		c.mu.Lock()
		defer c.mu.Unlock()

		entry.readers--
	}

	opened, err := os.Open(c.path(name))
	if err != nil {
		release()
		c.forget(name, entry)

		return nil, nil, fmt.Errorf("open the cached %s, which is fetched again next time: %w", c.path(name), err)
	}

	return opened, func() {
		_ = opened.Close()

		release()
	}, nil
}

// forget drops a cached file that has gone from the disk.
func (c *modelCache) forget(name string, entry *cachedFile) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.cached[name] == entry {
		c.used -= entry.size
		delete(c.cached, name)
	}
}

// stream sends the file name to the browser as it downloads, starting
// the download unless one is under way; the status says why the hub's
// answer did not start, and a download that breaks off later breaks the
// response off too, so a browser never takes a partial file for whole.
func (c *modelCache) stream(w http.ResponseWriter, r *http.Request, name string, file hubFile) {
	joined, reader, err := c.join(r.Context(), name, file)
	if err != nil {
		log.Printf("speech models: %v", err)
		http.Error(w, err.Error(), http.StatusServiceUnavailable)

		return
	}

	defer func() { _ = reader.Close() }()

	limit, err := joined.wait(0)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)

		return
	}

	w.Header().Set("Content-Length", strconv.FormatInt(file.size, 10))
	w.WriteHeader(http.StatusOK)

	buffer := make([]byte, min(streamChunk, file.size))

	for offset := int64(0); offset < file.size; {
		if offset >= limit {
			limit, err = joined.wait(offset)
			if err != nil {
				panic(http.ErrAbortHandler)
			}
		}

		read, err := reader.ReadAt(buffer[:min(int64(len(buffer)), limit-offset)], offset)
		if err != nil && !errors.Is(err, io.EOF) {
			log.Printf("speech models: read the download of %s: %v", name, err) //nolint:gosec // name is a path the manifest lists.
			panic(http.ErrAbortHandler)
		}

		_, err = w.Write(buffer[:read])
		if err != nil {
			return
		}

		offset += int64(read)
	}
}

// join returns the download of name under way, or starts it, and the
// partial file to read it from, opened before the download can rename
// or delete it.
func (c *modelCache) join(ctx context.Context, name string, file hubFile) (*download, *os.File, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if joined, ok := c.fetches[name]; ok {
		reader, err := os.Open(joined.partial)
		if err != nil {
			return nil, nil, fmt.Errorf("read the download of %s: %w", name, err)
		}

		return joined, reader, nil
	}

	err := c.evict(file.size)
	if err != nil {
		return nil, nil, fmt.Errorf("make room for %s: %w", name, err)
	}

	writer, err := os.CreateTemp(filepath.Join(c.dir, partialDir), "*")
	if err != nil {
		return nil, nil, fmt.Errorf("start the download of %s: %w", name, err)
	}

	reader, err := os.Open(writer.Name())
	if err != nil {
		_ = writer.Close()
		_ = os.Remove(writer.Name())

		return nil, nil, fmt.Errorf("read the download of %s: %w", name, err)
	}

	started := newDownload(writer.Name(), file.size)
	c.fetches[name] = started
	c.used += file.size

	go c.fetch(context.WithoutCancel(ctx), name, file, started, writer)

	return started, reader, nil
}

// fetch downloads name into its partial file and renames it into place
// once it is whole and matches the manifest. It runs on after the
// browser that started it goes, so the others reading along finish.
func (c *modelCache) fetch(ctx context.Context, name string, file hubFile, into *download, writer *os.File) {
	//nolint:gosec // name is a path the manifest lists.
	log.Printf("speech models: fetching %s from %s, %d bytes", name, c.hub.url(file), file.size)

	err := c.download(ctx, file, into, writer)
	if err == nil {
		err = os.MkdirAll(filepath.Dir(c.path(name)), dirMode)
	}

	c.mu.Lock()

	if err == nil {
		err = os.Rename(into.partial, c.path(name))
	}

	delete(c.fetches, name)

	if err != nil {
		c.used -= file.size
		_ = os.Remove(into.partial)
	} else {
		c.clock++
		c.cached[name] = &cachedFile{size: file.size, used: c.clock, readers: 0}
	}

	c.mu.Unlock()

	if err != nil {
		err = fmt.Errorf("fetch %s, which is not cached: %w", name, err)
		log.Printf("speech models: %v", err)
	}

	into.finish(err)
}

func (c *modelCache) download(ctx context.Context, file hubFile, into *download, writer *os.File) error {
	defer func() { _ = writer.Close() }()

	body, err := c.hub.open(ctx, file)
	if err != nil {
		return err
	}

	defer func() { _ = body.Close() }()

	sinks := []io.Writer{writer, into}

	var sum hash.Hash

	if file.digest != nil {
		sum = file.digest.newHash()
		sinks = append(sinks, sum)
	}

	written, err := io.Copy(io.MultiWriter(sinks...), io.LimitReader(body, file.size+1))
	if err != nil {
		return fmt.Errorf("download %s: %w", c.hub.url(file), err)
	}

	if written != file.size {
		return fmt.Errorf("%w from %s: %d bytes, want %d", errDownloadSize, c.hub.url(file), written, file.size)
	}

	err = writer.Sync()
	if err != nil {
		return fmt.Errorf("write the download of %s: %w", c.hub.url(file), err)
	}

	if sum == nil {
		return nil
	}

	if digest := sum.Sum(nil); !bytes.Equal(digest, file.digest.sum) {
		return fmt.Errorf("%w from %s: %s %x, want %x", errDigest, c.hub.url(file), file.digest.algorithm, digest, file.digest.sum)
	}

	return nil
}

// download is a file on its way from the hub, which browsers read along
// as it is written. Its last byte is held back until the file has been
// checked, so no browser gets all of a file that turns out wrong.
type download struct {
	partial string
	size    int64

	mu      sync.Mutex
	more    *sync.Cond
	written int64
	done    bool
	err     error
}

func newDownload(partial string, size int64) *download {
	started := &download{partial: partial, size: size, mu: sync.Mutex{}, more: nil, written: 0, done: false, err: nil}
	started.more = sync.NewCond(&started.mu)

	return started
}

// Write counts bytes the partial file has been given.
func (d *download) Write(chunk []byte) (int, error) {
	d.mu.Lock()
	d.written += int64(len(chunk))
	d.mu.Unlock()
	d.more.Broadcast()

	return len(chunk), nil
}

func (d *download) finish(err error) {
	d.mu.Lock()
	d.done = true
	d.err = err
	d.mu.Unlock()
	d.more.Broadcast()
}

// wait blocks until bytes past offset may be read, and returns how far.
func (d *download) wait(offset int64) (int64, error) {
	d.mu.Lock()
	defer d.mu.Unlock()

	for {
		if d.err != nil {
			return 0, d.err
		}

		readable := d.written
		if !d.done {
			readable = min(readable, d.size-1)
		}

		if readable > offset || d.done {
			return readable, nil
		}

		d.more.Wait()
	}
}
