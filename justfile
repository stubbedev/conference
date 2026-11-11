# conference dev / release tasks.
# Mirrors the CI gates (go vet/test/lint/build + web build) so a green
# `just check` predicts green CI.

default:
    @just --list

# vet + test + lint + web build, lint and tests + go build + browser
# smoke test (what ci.yml runs).
check: vet test lint brand web web-lint web-test build e2e e2e-share e2e-share-start

vet:
    go vet ./...

test:
    go test ./...

lint:
    golangci-lint run ./...

# Build the web UI into web/dist/app; the server binary embeds it.
web:
    cd web && npm ci && npm run build

# Copy what the browser speech engines need into web/public: ONNX
# Runtime's wasm and WebGPU builds and Piper's phonemizer.
speech-files:
    cd web && node scripts/vendor-speech.mjs

# Write DIR/models.json, naming the models and Piper voices the browser
# speech engines load and listing their files, which the server fetches
# from the Hugging Face Hub and caches in DIR as browsers ask for them
# (see docs/live-translation.md); nothing is downloaded here. Option:
# languages, as in
# `just speech-models /srv/speech-models en,de,da`. OPUS-MT pair models
# cover those languages unless a third argument narrows them, or is none:
# `just speech-models /srv/speech-models all en,de,da`.
speech-models dir languages="en" pair_languages="":
    node web/scripts/fetch-speech-models.mjs {{dir}} --languages={{languages}} {{ if pair_languages == "" { "" } else { "--pair-languages=" + pair_languages } }}

# oxlint over the web UI; any warning fails.
web-lint:
    cd web && npm run lint

# Unit tests for the web UI's pure modules (node --test).
web-test:
    cd web && npm test

build:
    CGO_ENABLED=0 go build -o /dev/null ./cmd/server

fmt:
    gofmt -w .

# Run backend (air hot reload) + vite dev server (HMR on
# http://localhost:5173) with a scratch database — the quickest way to
# try it locally. Ctrl+C stops both. air rebuilds and restarts the
# backend on every Go change and passes this shell's environment through
# to it: :18080 so it never fights other services for 8080, ICE and
# TURN on 15000/13478 for the same reason, and a scratch SQLite in /tmp.
# vite proxies /api and /ws to
# it. The toolchain (go, air, just, node) comes from the flake dev shell
# — see nix/shell.nix.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    (cd web && [ -d node_modules ] || npm ci)
    export PORT=18080
    export ICE_UDP_PORT=15000
    export TURN_PORT=13478
    export DB_PATH=/tmp/conference-dev.db
    export BACKEND_ORIGIN=http://localhost:18080
    if ! command -v air >/dev/null 2>&1; then
        echo "air is missing — enter the dev shell (direnv) or: go install github.com/air-verse/air@latest" >&2
        exit 1
    fi
    air &
    backend=$!
    trap 'kill "$backend" 2>/dev/null || true' EXIT
    cd web && npm run dev

# Two headless Chromes with fake cameras join a room through a freshly
# built server and must exchange E2EE audio and video, and a recording
# must contain the other side's voice. Needs Chrome on PATH (or
# CHROME=/path/to/chrome) and ffmpeg.
e2e:
    node web/e2e/smoke.mjs

# A shared screen scrolled in bursts with still pauses between them,
# presented from Chrome and from Firefox: every burst must play fluidly
# after the screen sat still. Prints the share second by second. Needs
# Chrome and Firefox on PATH (or CHROME= and FIREFOX=); `--skip-firefox`
# measures Chrome alone.
e2e-share *args:
    node web/e2e/share-burst.mjs {{args}}

# A share started and stopped over and over, presented from Chrome and
# from Firefox: every start must be sent and decoded, with the garbage
# collection that used to leave a start sending nothing forced in Chrome
# at every one. Needs Chrome and Firefox on PATH (or CHROME= and
# FIREFOX=); `--skip-firefox` pairs two Chromes, `--load N` adds N busy
# loops.
e2e-share-start *args:
    node web/e2e/share-start.mjs {{args}}

# Regenerate the logo, favicon, touch icon and link-preview card in
# web/public from web/brand (needs Inkscape, in the dev shell).
icons:
    node web/brand/brand.mjs

# Fail when web/public's brand assets no longer match web/brand.
brand:
    node web/brand/brand.mjs --check

# Run the server on :8080 serving the built UI (run `just web` first).
run:
    DB_PATH=/tmp/conference-dev.db go run ./cmd/server

# Build the Docker image locally.
docker:
    docker build -t conference:dev .

# Show the next major/minor/patch versions.
release-preview:
    #!/usr/bin/env bash
    set -euo pipefail
    v="$(git describe --tags --abbrev=0 2>/dev/null || echo v0.0.0)"
    IFS=. read -r maj min pat <<<"${v#v}"
    echo "current: $v"
    echo "patch:   v$maj.$min.$((pat + 1))"
    echo "minor:   v$maj.$((min + 1)).0"
    echo "major:   v$((maj + 1)).0.0"

release-patch: (release "patch")
release-minor: (release "minor")
release-major: (release "major")

# Run the CI gates, tag HEAD, and push the branch and the tag (the tag
# push triggers .github/workflows/release.yml, which publishes the
# Docker image).
release level:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! git diff --quiet || ! git diff --cached --quiet; then
        echo "working tree is dirty — commit or stash first" >&2
        exit 1
    fi
    v="$(git describe --tags --abbrev=0 2>/dev/null || echo v0.0.0)"
    IFS=. read -r maj min pat <<<"${v#v}"
    case "{{ level }}" in
        patch) next="v$maj.$min.$((pat + 1))" ;;
        minor) next="v$maj.$((min + 1)).0" ;;
        major) next="v$((maj + 1)).0.0" ;;
        *) echo "level must be patch, minor or major" >&2; exit 1 ;;
    esac
    echo "releasing $v -> $next"
    just check
    git tag "$next"
    git push origin HEAD
    git push origin "$next"
    echo "released $next"

# Live translation end to end with stand-in speech engines: two headless
# Chromes must get each other's subtitles and translated voice. Needs
# Chrome. SPEECH_RUNTIME=browser runs the engines in the browsers instead,
# on the same stand-ins.
e2e-translate:
    node web/e2e/translate.mjs

# The same test where every browser runs the speech engines itself.
e2e-translate-browser:
    SPEECH_RUNTIME=browser node web/e2e/translate.mjs

# Voice detection in a browser, on the model and ONNX Runtime the build
# vendors: no download, no GPU. Needs Chrome and a built UI (just web).
e2e-speech:
    node web/e2e/speech-vad.mjs

# The browser engines on the real models, served by a freshly built
# server from DIR, whose models.json `just speech-models` writes; the
# server caches the files it fetches in DIR.
e2e-speech-engines dir:
    SPEECH_MODEL_DIR={{dir}} node web/e2e/speech-engines.mjs

# Live-translation demo: you (English, real mic) and a guest; options: hear, sv, male, openai.
translate-demo *args:
    node web/e2e/translate-demo.mjs {{args}}

# Live translation between computers on the same network (HTTPS on :8443); option: openai.
translate-lan *args:
    node web/e2e/translate-lan.mjs {{args}}

# Stream the fixtures through the speech service with the engines the
# environment sets up (see docs/live-translation.md) and check the
# translations both ways.
speech-test:
    go run ./cmd/speechcheck
