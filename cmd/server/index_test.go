package main

import (
	"errors"
	"testing"
)

const indexFixture = `<!doctype html>
<html lang="en">
  <head>
    <title>conference</title>
    <meta property="og:title" content="conference">
    <meta property="og:image" content="/og-image.png">
    <meta content="/og-image.png" name="twitter:image">
    <meta property="og:url" content="/">
  </head>
  <body><div id="root"></div></body>
</html>
`

func TestAbsolutePreviewURLs(t *testing.T) {
	t.Parallel()

	got, err := absolutePreviewURLs([]byte(indexFixture), "https://meet.example.com")
	if err != nil {
		t.Fatal(err)
	}

	want := `<!doctype html>
<html lang="en">
  <head>
    <title>conference</title>
    <meta property="og:title" content="conference">
    <meta property="og:image" content="https://meet.example.com/og-image.png">
    <meta content="https://meet.example.com/og-image.png" name="twitter:image">
    <meta property="og:url" content="/">
  </head>
  <body><div id="root"></div></body>
</html>
`
	if string(got) != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestAbsolutePreviewURLsWithoutOrigin(t *testing.T) {
	t.Parallel()

	got, err := absolutePreviewURLs([]byte(indexFixture), "")
	if err != nil {
		t.Fatal(err)
	}

	if string(got) != indexFixture {
		t.Fatalf("changed the page without an origin:\n%s", got)
	}
}

func TestAbsolutePreviewURLsRequiresPreviewImage(t *testing.T) {
	t.Parallel()

	_, err := absolutePreviewURLs([]byte(`<html><head><title>x</title></head></html>`), "https://meet.example.com")
	if !errors.Is(err, errNoPreviewImage) {
		t.Fatalf("got %v, want %v", err, errNoPreviewImage)
	}
}

func TestAbsolutePreviewURLsKeepsAbsolute(t *testing.T) {
	t.Parallel()

	page := `<meta property="og:image" content="https://cdn.example.com/card.png">`

	got, err := absolutePreviewURLs([]byte(page), "https://meet.example.com")
	if err != nil {
		t.Fatal(err)
	}

	if string(got) != page {
		t.Fatalf("rewrote an absolute URL: %s", got)
	}
}
