package service

import (
	"crypto/md5" //nolint:gosec // piper-voices names its files by MD5; it checks a download, it protects nothing.
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io/fs"
	"maps"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
)

// The manifest in models.json names every file the browsers may load:
// where this server fetches it from on the Hugging Face Hub, at which
// commit, what it weighs and, where the Hub gives one, its digest.

var (
	errManifestEmpty    = errors.New("names no files; write it again with web/scripts/fetch-speech-models.mjs")
	errManifestPath     = errors.New("must be a relative path without dot segments or hidden names")
	errManifestRevision = errors.New("must be a commit, 40 lowercase hex digits")
	errManifestSize     = errors.New("must not be negative")
	errManifestDigest   = errors.New("must be one hex digest, sha256 or md5, not both")
	errManifestOwnFile  = errors.New("is the models file itself, which is not a model file")
)

var revisionPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

// manifestEntry is one file of the manifest as models.json writes it.
type manifestEntry struct {
	Repo     string `json:"repo"`
	Revision string `json:"revision"`
	File     string `json:"file"`
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256,omitempty"`
	MD5      string `json:"md5,omitempty"`
}

// digestAlgorithm is how the Hub checksums a file.
type digestAlgorithm string

const (
	digestSHA256 digestAlgorithm = "sha256"
	digestMD5    digestAlgorithm = "md5"
)

// fileDigest is the checksum a file has to match; a nil one means the
// Hub gives none and the size alone checks the file.
type fileDigest struct {
	algorithm digestAlgorithm
	sum       []byte
}

func (d fileDigest) newHash() hash.Hash {
	if d.algorithm == digestMD5 {
		return md5.New() //nolint:gosec // See the import.
	}

	return sha256.New()
}

// hubFile is a file of a Hugging Face repository at a commit, checked.
type hubFile struct {
	repo     string
	revision string
	name     string
	size     int64
	digest   *fileDigest
}

// etag is the validator a browser resumes the file with. The bytes at a
// commit never change, so the commit is enough.
func (f hubFile) etag() string {
	return `"` + f.revision + `"`
}

// manifest is every file the browsers may load, by its path under
// ModelsPath.
type manifest map[string]hubFile

func (m manifest) size(name, what string) (int64, error) {
	file, ok := m[name]
	if !ok {
		return 0, fmt.Errorf("%s %w from the manifest: %s", what, errModelsMissing, name)
	}

	return file.size, nil
}

// largest is the path of the largest file and its size.
func (m manifest) largest() (string, int64) {
	var (
		name string
		size int64 = -1
	)

	for _, key := range slices.Sorted(maps.Keys(m)) {
		if m[key].size > size {
			name, size = key, m[key].size
		}
	}

	return name, size
}

// parseManifest checks every entry of the manifest: a path a browser can
// ask for, a repository, a commit, a size a browser can load and at most
// one digest. modelsFile is where models.json lives, which may be in dir
// but is never one of its model files.
func parseManifest(entries map[string]manifestEntry, dir, modelsFile string) (manifest, error) {
	if len(entries) == 0 {
		return nil, fmt.Errorf("files %w", errManifestEmpty)
	}

	own, err := filepath.Abs(modelsFile)
	if err != nil {
		return nil, fmt.Errorf("resolve %s: %w", modelsFile, err)
	}

	files := make(manifest, len(entries))

	for _, name := range slices.Sorted(maps.Keys(entries)) {
		file, err := parseManifestEntry(name, entries[name])
		if err != nil {
			return nil, err
		}

		cached, err := filepath.Abs(filepath.Join(dir, filepath.FromSlash(name)))
		if err != nil {
			return nil, fmt.Errorf("resolve %s in %s: %w", name, dir, err)
		}

		if cached == own {
			return nil, fmt.Errorf("files %q %w", name, errManifestOwnFile)
		}

		files[name] = file
	}

	return files, nil
}

func parseManifestEntry(name string, entry manifestEntry) (hubFile, error) {
	what := fmt.Sprintf("files %q", name)

	if !servablePath(name) {
		return hubFile{}, fmt.Errorf("%s %w", what, errManifestPath)
	}

	err := checkModelID(what+" repo", entry.Repo)
	if err != nil {
		return hubFile{}, err
	}

	if !revisionPattern.MatchString(entry.Revision) {
		return hubFile{}, fmt.Errorf("%s revision %q %w", what, entry.Revision, errManifestRevision)
	}

	if !servablePath(entry.File) {
		return hubFile{}, fmt.Errorf("%s file %q %w", what, entry.File, errManifestPath)
	}

	if entry.Size < 0 {
		return hubFile{}, fmt.Errorf("%s size %d %w", what, entry.Size, errManifestSize)
	}

	if entry.Size > maxBrowserFile {
		return hubFile{}, fmt.Errorf("%s %w, %d bytes against %d", what, errModelsTooLarge, entry.Size, maxBrowserFile)
	}

	digest, err := parseDigest(entry)
	if err != nil {
		return hubFile{}, fmt.Errorf("%s %w", what, err)
	}

	return hubFile{repo: entry.Repo, revision: entry.Revision, name: entry.File, size: entry.Size, digest: digest}, nil
}

func parseDigest(entry manifestEntry) (*fileDigest, error) {
	algorithm, value := digestSHA256, entry.SHA256

	switch {
	case entry.SHA256 != "" && entry.MD5 != "":
		return nil, fmt.Errorf("sha256 %q and md5 %q %w", entry.SHA256, entry.MD5, errManifestDigest)
	case entry.MD5 != "":
		algorithm, value = digestMD5, entry.MD5
	case entry.SHA256 == "":
		return nil, nil //nolint:nilnil // A file the Hub gives no digest for is checked by its size alone.
	}

	digest := &fileDigest{algorithm: algorithm, sum: nil}

	sum, err := hex.DecodeString(value)
	if err != nil || len(sum) != digest.newHash().Size() {
		return nil, fmt.Errorf("%s %q %w", algorithm, value, errManifestDigest)
	}

	digest.sum = sum

	return digest, nil
}

// servablePath reports whether name is a path in the model directory a
// browser may ask for: no dot segments, and no hidden name, which keeps
// the cache's own partial downloads out of reach.
func servablePath(name string) bool {
	if !fs.ValidPath(name) || name == "." {
		return false
	}

	for part := range strings.SplitSeq(name, "/") {
		if strings.HasPrefix(part, ".") {
			return false
		}
	}

	return true
}
