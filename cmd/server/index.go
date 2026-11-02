package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"

	"golang.org/x/net/html"
)

var errNoPreviewImage = errors.New("index.html has no og:image or twitter:image meta tag")

// isPreviewImageKey reports whether a meta tag's property or name marks
// an image that link previewers (Slack, Discord, iMessage, Facebook)
// only accept as an absolute URL.
func isPreviewImageKey(key string) bool {
	return key == "og:image" || key == "twitter:image"
}

// absolutePreviewURLs rewrites the root-relative content of every
// preview-image meta tag in index to origin+path, leaving every other
// byte untouched. Without an origin the page is returned unchanged.
func absolutePreviewURLs(index []byte, origin string) ([]byte, error) {
	if origin == "" {
		return index, nil
	}

	var out bytes.Buffer

	out.Grow(len(index))

	found := false
	tokens := html.NewTokenizer(bytes.NewReader(index))

	for {
		kind := tokens.Next()
		if kind == html.ErrorToken {
			if errors.Is(tokens.Err(), io.EOF) {
				break
			}

			return nil, fmt.Errorf("parse index.html: %w", tokens.Err())
		}

		raw := tokens.Raw()

		if kind != html.StartTagToken && kind != html.SelfClosingTagToken {
			out.Write(raw)

			continue
		}

		token := tokens.Token()

		content, ok := previewImageContent(token)
		if !ok {
			out.Write(raw)

			continue
		}

		found = true

		if !strings.HasPrefix(token.Attr[content].Val, "/") {
			out.Write(raw)

			continue
		}

		token.Attr[content].Val = origin + token.Attr[content].Val
		out.WriteString(token.String())
	}

	if !found {
		return nil, errNoPreviewImage
	}

	return out.Bytes(), nil
}

// previewImageContent returns the index of token's content attribute
// when token is a preview-image meta tag.
func previewImageContent(token html.Token) (int, bool) {
	if token.Data != "meta" {
		return 0, false
	}

	isPreviewImage := false
	content := -1

	for i, attr := range token.Attr {
		switch attr.Key {
		case "property", "name":
			isPreviewImage = isPreviewImage || isPreviewImageKey(attr.Val)
		case "content":
			content = i
		}
	}

	return content, isPreviewImage && content >= 0
}
