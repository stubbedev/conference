package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const (
	cacheRepo   = "owner/model"
	testStall   = 200 * time.Millisecond
	waitForTest = 10 * time.Second
	cacheRoom   = 1 << 20

	modelOnnx = "onnx/model.onnx"
	aOnnx     = "a.onnx"
	bOnnx     = "b.onnx"
	cOnnx     = "c.onnx"
)

// hosted is a manifest of contents, files of cacheRepo by name, with
// the SHA-256 of each.
func hosted(contents map[string]string) map[string]manifestEntry {
	entries := make(map[string]manifestEntry, len(contents))

	for name, content := range contents {
		sum := sha256.Sum256([]byte(content))
		entries[cacheRepo+"/"+name] = manifestEntry{
			Repo: cacheRepo, Revision: testRevision, File: name, Size: int64(len(content)), SHA256: hex.EncodeToString(sum[:]), MD5: "",
		}
	}

	return entries
}

// serveContents answers as the hub does for the files of cacheRepo.
func serveContents(contents map[string]string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		name, ok := strings.CutPrefix(r.URL.Path, "/"+cacheRepo+"/resolve/"+testRevision+"/")

		content, found := contents[name]
		if !ok || !found {
			http.NotFound(w, r)

			return
		}

		w.Header().Set("Content-Length", strconv.Itoa(len(content)))
		_, _ = io.WriteString(w, content)
	}
}

func flush(w http.ResponseWriter) {
	w.(http.Flusher).Flush() //nolint:forcetypeassert // httptest's writer flushes.
}

type testCache struct {
	cache    *modelCache
	server   *httptest.Server
	dir      string
	requests *atomic.Int64
}

func newTestCache(t *testing.T, dir string, entries map[string]manifestEntry, limit int64, upstream http.HandlerFunc) (testCache, error) {
	t.Helper()

	requests := &atomic.Int64{}
	hubServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		upstream(w, r)
	}))
	t.Cleanup(hubServer.Close)

	base, err := url.Parse(hubServer.URL)
	if err != nil {
		t.Fatalf("hub address: %v", err)
	}

	source := newHub(base)
	source.stall = testStall

	files, err := parseManifest(entries, dir, filepath.Join(t.TempDir(), "models.json"))
	if err != nil {
		t.Fatalf("manifest: %v", err)
	}

	cache, err := newModelCache(dir, files, limit, source)
	if err != nil {
		return testCache{cache: nil, server: nil, dir: dir, requests: requests}, err
	}

	server := httptest.NewServer(cache)
	t.Cleanup(server.Close)

	return testCache{cache: cache, server: server, dir: dir, requests: requests}, nil
}

func startTestCache(t *testing.T, entries map[string]manifestEntry, limit int64, upstream http.HandlerFunc) testCache {
	t.Helper()

	started, err := newTestCache(t, t.TempDir(), entries, limit, upstream)
	if err != nil {
		t.Fatalf("cache: %v", err)
	}

	return started
}

type answer struct {
	status int
	header http.Header
	body   string
	err    error
}

func (c testCache) request(t *testing.T, method, name string, header map[string]string) answer {
	t.Helper()

	ctx, cancel := context.WithTimeout(context.Background(), waitForTest)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, method, c.server.URL+ModelsPath+name, nil)
	if err != nil {
		t.Fatalf("request %s: %v", name, err)
	}

	for key, value := range header {
		request.Header.Set(key, value)
	}

	response, err := c.server.Client().Do(request)
	if err != nil {
		return answer{status: 0, header: nil, body: "", err: err}
	}

	defer func() { _ = response.Body.Close() }()

	body, err := io.ReadAll(response.Body)

	return answer{status: response.StatusCode, header: response.Header, body: string(body), err: err}
}

// get fetches a file of cacheRepo and fails the test unless it comes
// whole.
func (c testCache) get(t *testing.T, name, want string) answer {
	t.Helper()

	got := c.request(t, http.MethodGet, cacheRepo+"/"+name, nil)
	if got.err != nil || got.status != http.StatusOK || got.body != want {
		t.Fatalf("GET %s: %d, %d bytes, %v; want %d bytes", name, got.status, len(got.body), got.err, len(want))
	}

	return got
}

func (c testCache) status(t *testing.T, method, name string) int {
	t.Helper()

	return c.request(t, method, name, nil).status
}

func (c testCache) cachedOnDisk(t *testing.T, name string) bool {
	t.Helper()

	_, err := os.Stat(filepath.Join(c.dir, filepath.FromSlash(cacheRepo+"/"+name)))
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("stat %s: %v", name, err)
	}

	return err == nil
}

// expectCached fails the test unless exactly the files want names as
// true are cached.
func (c testCache) expectCached(t *testing.T, when string, want map[string]bool) {
	t.Helper()

	for name, cached := range want {
		if c.cachedOnDisk(t, name) != cached {
			t.Errorf("%s: %s cached %v, want %v", when, name, !cached, cached)
		}
	}
}

func (c testCache) expectFetches(t *testing.T, when string, want int64) {
	t.Helper()

	if got := c.requests.Load(); got != want {
		t.Fatalf("%s: %d fetches from the hub, want %d", when, got, want)
	}
}

func TestModelCacheFetchesAMissOnceAndServesItFromDisk(t *testing.T) {
	t.Parallel()

	contents := map[string]string{modelConfig: `{"a":1}`, modelOnnx: "weights-weights"}
	cache := startTestCache(t, hosted(contents), cacheRoom, serveContents(contents))

	head := cache.request(t, http.MethodHead, cacheRepo+"/"+modelConfig, nil)
	if head.status != http.StatusOK || head.header.Get("Content-Length") != "7" || head.header.Get("Content-Type") != "application/json" {
		t.Fatalf("HEAD of a file not cached: %d %v", head.status, head.header)
	}

	cache.expectFetches(t, "after a HEAD", 0)

	for range 2 {
		got := cache.get(t, modelOnnx, contents[modelOnnx])
		if got.header.Get("ETag") != `"`+testRevision+`"` || !strings.Contains(got.header.Get("Cache-Control"), "immutable") {
			t.Fatalf("headers %v, want the commit as the ETag and immutable", got.header)
		}
	}

	cache.expectFetches(t, "after two GETs", 1)
	cache.expectCached(t, "after a GET", map[string]bool{modelOnnx: true, modelConfig: false})

	ranged := cache.request(t, http.MethodGet, cacheRepo+"/"+modelOnnx, map[string]string{"Range": "bytes=2-4"})
	if ranged.status != http.StatusPartialContent || ranged.body != "igh" {
		t.Fatalf("range from the cache: %d %q", ranged.status, ranged.body)
	}
}

func TestModelCacheSharesOneDownloadBetweenBrowsers(t *testing.T) {
	t.Parallel()

	const (
		browsers = 10
		half     = 64 << 10
	)

	content := strings.Repeat("a", half) + strings.Repeat("b", half)
	release := make(chan struct{})

	cache := startTestCache(t, hosted(map[string]string{modelOnnx: content}), cacheRoom, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Length", strconv.Itoa(len(content)))
		_, _ = io.WriteString(w, content[:half])
		flush(w)
		<-release

		_, _ = io.WriteString(w, content[half:])
	})

	var halfway, done sync.WaitGroup

	failures := make(chan string, browsers)

	for range browsers {
		halfway.Add(1)
		done.Go(func() {
			read := streamHalves(cache, half, &halfway)
			if read != content {
				failures <- "a browser read " + strconv.Itoa(len(read)) + " bytes, not the file"
			}
		})
	}

	waited := make(chan struct{})

	go func() {
		halfway.Wait()
		close(waited)
	}()

	select {
	case <-waited:
	case <-time.After(waitForTest):
		t.Fatal("the browsers did not all read the first half while the download was held")
	}

	close(release)
	done.Wait()
	close(failures)

	for failure := range failures {
		t.Error(failure)
	}

	cache.expectFetches(t, strconv.Itoa(browsers)+" browsers at once", 1)
}

// streamHalves reads the first half of the model, says so, and reads the
// rest; it returns what it read.
func streamHalves(cache testCache, half int, halfway *sync.WaitGroup) string {
	signalled := false

	signal := func() {
		if !signalled {
			signalled = true

			halfway.Done()
		}
	}

	defer signal()

	ctx, cancel := context.WithTimeout(context.Background(), waitForTest)
	defer cancel()

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, cache.server.URL+ModelsPath+cacheRepo+"/"+modelOnnx, nil)
	if err != nil {
		return ""
	}

	response, err := cache.server.Client().Do(request)
	if err != nil {
		return ""
	}

	defer func() { _ = response.Body.Close() }()

	first := make([]byte, half)

	_, err = io.ReadFull(response.Body, first)
	if err != nil {
		return ""
	}

	signal()

	rest, err := io.ReadAll(response.Body)
	if err != nil {
		return ""
	}

	return string(first) + string(rest)
}

func TestModelCacheServesNothingOutsideTheManifest(t *testing.T) {
	t.Parallel()

	contents := map[string]string{modelConfig: "{}"}
	cache := startTestCache(t, hosted(contents), cacheRoom, serveContents(map[string]string{modelConfig: "{}", "secret.json": "{}"}))
	outside := []string{cacheRepo + "/secret.json", "", cacheRepo + "/", "other/model/" + modelConfig, cacheRepo + "/../model/" + modelConfig}

	for _, name := range outside {
		if status := cache.status(t, http.MethodGet, name); status != http.StatusNotFound {
			t.Errorf("GET %q: %d, want 404", name, status)
		}
	}

	if status := cache.status(t, http.MethodPost, cacheRepo+"/"+modelConfig); status != http.StatusMethodNotAllowed {
		t.Errorf("POST: %d, want 405", status)
	}

	cache.expectFetches(t, "for paths outside the manifest", 0)
}

func brokenHubs(content string) map[string]http.HandlerFunc {
	chunked := func(body string) http.HandlerFunc {
		return func(w http.ResponseWriter, _ *http.Request) {
			_, _ = io.WriteString(w, body)
			flush(w)
		}
	}

	return map[string]http.HandlerFunc{
		"short":   chunked(content[:len(content)-3]),
		"long":    chunked(content + "more"),
		"corrupt": chunked(strings.ToUpper(content[:1]) + content[1:]),
		"failing": func(w http.ResponseWriter, _ *http.Request) { http.Error(w, "down", http.StatusInternalServerError) },
		"announced too long": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Length", strconv.Itoa(len(content)+1))
			_, _ = io.WriteString(w, content+"x")
		},
		"stalled": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Length", strconv.Itoa(len(content)))
			_, _ = io.WriteString(w, content[:len(content)/2])
			flush(w)
			<-r.Context().Done()
		},
	}
}

func TestModelCacheKeepsNoBrokenDownload(t *testing.T) {
	t.Parallel()

	content := strings.Repeat("weights", 10<<10)

	for label, upstream := range brokenHubs(content) {
		t.Run(label, func(t *testing.T) {
			t.Parallel()

			var healthy atomic.Bool

			cache := startTestCache(t, hosted(map[string]string{modelOnnx: content}), cacheRoom, func(w http.ResponseWriter, r *http.Request) {
				if healthy.Load() {
					serveContents(map[string]string{modelOnnx: content})(w, r)

					return
				}

				upstream(w, r)
			})

			got := cache.request(t, http.MethodGet, cacheRepo+"/"+modelOnnx, nil)
			if got.err == nil && got.status == http.StatusOK && got.body == content {
				t.Fatal("a browser got the whole file from a broken download")
			}

			partial, err := os.ReadDir(filepath.Join(cache.dir, partialDir))
			if err != nil || len(partial) != 0 {
				t.Fatalf("partial files %v (%v) after a broken download, want none", partial, err)
			}

			cache.expectCached(t, "after a broken download", map[string]bool{modelOnnx: false})

			healthy.Store(true)
			cache.get(t, modelOnnx, content)
			cache.expectCached(t, "after the hub recovered", map[string]bool{modelOnnx: true})
		})
	}
}

func TestModelCacheEvictsTheLeastRecentlyUsed(t *testing.T) {
	t.Parallel()

	contents := map[string]string{aOnnx: "aaaaaaaaaa", bOnnx: "bbbbbbbbbb", cOnnx: "cccccccccc"}
	cache := startTestCache(t, hosted(contents), 20, serveContents(contents))

	for _, name := range []string{aOnnx, bOnnx, aOnnx, cOnnx} {
		cache.get(t, name, contents[name])
	}

	cache.expectCached(t, "b used least recently", map[string]bool{aOnnx: true, bOnnx: false, cOnnx: true})

	releases := make([]func(), 0, 2)

	for _, name := range []string{aOnnx, cOnnx} {
		opened, release, err := cache.cache.hit(cacheRepo + "/" + name)
		if err != nil || opened == nil {
			t.Fatalf("read %s from the cache: %v", name, err)
		}

		releases = append(releases, release)
	}

	if status := cache.status(t, http.MethodGet, cacheRepo+"/"+bOnnx); status != http.StatusServiceUnavailable {
		t.Fatalf("GET with every cached file being read: %d, want 503", status)
	}

	for _, release := range releases {
		release()
	}

	cache.get(t, bOnnx, contents[bOnnx])
	cache.expectCached(t, "a read before c", map[string]bool{aOnnx: false, bOnnx: true, cOnnx: true})
}

func TestModelCacheAdoptsTheFilesAlreadyOnDisk(t *testing.T) {
	t.Parallel()

	const tokenizer = "tokenizer.json" //nolint:gosec // A file name, not a credential.

	contents := map[string]string{modelConfig: `{"a":1}`, tokenizer: "[1]", modelOnnx: "weights"}
	dir := t.TempDir()
	root := filepath.Join(dir, filepath.FromSlash(cacheRepo))
	oldest := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

	for name, content := range map[string]string{modelConfig: contents[modelConfig], tokenizer: contents[tokenizer], modelOnnx: "stale"} {
		writeFile(t, filepath.Join(root, filepath.FromSlash(name)), content)
	}

	err := os.Chtimes(filepath.Join(root, tokenizer), oldest, oldest)
	if err != nil {
		t.Fatalf("age the tokenizer: %v", err)
	}

	writeFile(t, filepath.Join(dir, partialDir, "left-over"), "half")

	limit := int64(len(contents[modelConfig]) + len(contents[tokenizer]) - 1)

	cache, err := newTestCache(t, dir, hosted(contents), limit, serveContents(contents))
	if err != nil {
		t.Fatalf("cache: %v", err)
	}

	cache.expectCached(t, "at start", map[string]bool{modelConfig: true, tokenizer: false, modelOnnx: false})

	_, err = os.Stat(filepath.Join(dir, partialDir, "left-over"))
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("a partial download outlived the restart: %v", err)
	}

	cache.get(t, modelConfig, contents[modelConfig])
	cache.expectFetches(t, "for an adopted file", 0)

	cache.get(t, modelOnnx, contents[modelOnnx])
	cache.expectFetches(t, "for a stale file", 1)
}

func TestModelCacheRefusesALimitBelowTheLargestFile(t *testing.T) {
	t.Parallel()

	contents := map[string]string{modelConfig: "{}", modelOnnx: "weights"}

	_, err := newTestCache(t, t.TempDir(), hosted(contents), int64(len("weights")-1), serveContents(contents))
	if !errors.Is(err, errCacheLimit) || !strings.Contains(err.Error(), modelOnnx) {
		t.Fatalf("err %v, want a refusal naming the largest file", err)
	}

	settings := browserSettings(t, listed(asrModel, danish, mtModel), browserChoices(), map[string]string{envModelCacheMax: "3B"})

	_, _, err = Start(settings, nil)
	if err == nil || !strings.Contains(err.Error(), envModelCacheMax) {
		t.Fatalf("start: %v, want a refusal naming %s", err, envModelCacheMax)
	}
}

func TestCacheLimitSetting(t *testing.T) {
	t.Parallel()

	for value, want := range map[string]int64{
		"": defaultCacheLimit, "15GB": 15 * gigabyte, "512MiB": 512 * mebibyte, "100": 100, "2 kB": 2 * kilobyte, "1TiB": tebibyte,
	} {
		if got := load(t, map[string]string{envModelCacheMax: value}).cacheLimit; got != want {
			t.Errorf("%s=%q: %d bytes, want %d", envModelCacheMax, value, got, want)
		}
	}

	for _, value := range []string{"1.5GB", "GB", "-1GB", "15PB", "9999999999TB", "15 G B"} {
		_, err := FromEnv(lookup(map[string]string{envModelCacheMax: value}))
		if !errors.Is(err, errByteSize) {
			t.Errorf("%s=%q: %v, want a refusal", envModelCacheMax, value, err)
		}
	}
}

func TestRetryAfterIsBounded(t *testing.T) {
	t.Parallel()

	for header, want := range map[string]time.Duration{
		"155":                           155 * time.Second,
		"86400":                         maxRetryAfter,
		"":                              defaultRetryAfter,
		"0":                             defaultRetryAfter,
		"Wed, 21 Oct 2026 07:28:00 GMT": defaultRetryAfter,
	} {
		if got := retryAfter(header); got != want {
			t.Errorf("Retry-After %q: %s, want %s", header, got, want)
		}
	}
}

func writeFile(t *testing.T, file, content string) {
	t.Helper()

	err := os.MkdirAll(filepath.Dir(file), 0o750)
	if err != nil {
		t.Fatalf("mkdir: %v", err)
	}

	err = os.WriteFile(file, []byte(content), 0o600)
	if err != nil {
		t.Fatalf("write %s: %v", file, err)
	}
}
