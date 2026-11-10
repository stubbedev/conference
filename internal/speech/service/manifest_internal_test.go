package service

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestManifestRefusesWhatIsNoModelFile(t *testing.T) {
	t.Parallel()

	good := manifestEntry{Repo: mtModel, Revision: testRevision, File: modelConfig, Size: configSize, SHA256: "", MD5: ""}
	sha256 := strings.Repeat("ab", 32)
	md5 := strings.Repeat("cd", 16)
	listed := mtModel + "/" + modelConfig

	variant := func(change func(*manifestEntry)) manifestEntry {
		entry := good
		change(&entry)

		return entry
	}

	cases := map[string]struct {
		name  string
		entry manifestEntry
		want  error
	}{
		"dot segment":       {name: mtModel + "/../" + modelConfig, entry: good, want: errManifestPath},
		"absolute":          {name: "/" + listed, entry: good, want: errManifestPath},
		"hidden":            {name: partialDir + "/" + modelConfig, entry: good, want: errManifestPath},
		"directory":         {name: mtModel + "/", entry: good, want: errManifestPath},
		"branch":            {name: listed, entry: variant(func(e *manifestEntry) { e.Revision = "main" }), want: errManifestRevision},
		"repository":        {name: listed, entry: variant(func(e *manifestEntry) { e.Repo = "m2m100" }), want: errModelsDir},
		"repository file":   {name: listed, entry: variant(func(e *manifestEntry) { e.File = "../" + modelConfig }), want: errManifestPath},
		"negative size":     {name: listed, entry: variant(func(e *manifestEntry) { e.Size = -1 }), want: errManifestSize},
		"too large":         {name: listed, entry: variant(func(e *manifestEntry) { e.Size = maxBrowserFile + 1 }), want: errModelsTooLarge},
		"two digests":       {name: listed, entry: variant(func(e *manifestEntry) { e.SHA256, e.MD5 = sha256, md5 }), want: errManifestDigest},
		"short digest":      {name: listed, entry: variant(func(e *manifestEntry) { e.SHA256 = md5 }), want: errManifestDigest},
		"digest is not hex": {name: listed, entry: variant(func(e *manifestEntry) { e.MD5 = strings.Repeat("zz", 16) }), want: errManifestDigest},
	}

	for label, tc := range cases {
		_, err := parseManifest(map[string]manifestEntry{tc.name: tc.entry}, t.TempDir(), "models.json")
		if !errors.Is(err, tc.want) {
			t.Errorf("%s: err %v, want %v", label, err, tc.want)
		}
	}
}

func TestManifestReadsDigests(t *testing.T) {
	t.Parallel()

	const (
		onnxFile  = "a/b/c.onnx"
		voiceFile = "piper/v.onnx"
		jsonFile  = "a/b/c.json"
	)

	files, err := parseManifest(map[string]manifestEntry{
		onnxFile:  {Repo: "a/b", Revision: testRevision, File: "c.onnx", Size: 1, SHA256: strings.Repeat("ab", 32), MD5: ""},
		voiceFile: {Repo: piperRepo, Revision: testRevision, File: "x/v.onnx", Size: 1, SHA256: "", MD5: strings.Repeat("cd", 16)},
		jsonFile:  {Repo: "a/b", Revision: testRevision, File: "c.json", Size: 1, SHA256: "", MD5: ""},
	}, t.TempDir(), "models.json")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	if files[onnxFile].digest.algorithm != digestSHA256 || files[voiceFile].digest.algorithm != digestMD5 {
		t.Errorf("digests %+v and %+v, want sha256 and md5", files[onnxFile].digest, files[voiceFile].digest)
	}

	if files[jsonFile].digest != nil {
		t.Errorf("digest %+v for a file the hub gives none for", files[jsonFile].digest)
	}
}

func TestManifestKeepsTheModelsFileOutOfTheCache(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	entry := manifestEntry{Repo: mtModel, Revision: testRevision, File: modelConfig, Size: configSize, SHA256: "", MD5: ""}

	_, err := parseManifest(map[string]manifestEntry{"models/models.json": entry}, dir, filepath.Join(dir, "models", "models.json"))
	if !errors.Is(err, errManifestOwnFile) {
		t.Fatalf("err %v, want the models file refused", err)
	}
}
