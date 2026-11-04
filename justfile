# conference dev / release tasks.
# Mirrors the CI gates (go vet/test/lint/build + web build) so a green
# `just check` predicts green CI.

default:
    @just --list

# vet + test + lint + web build, lint and tests + go build + browser
# smoke test (what ci.yml runs).
check: vet test lint brand web web-lint web-test build e2e

vet:
    go vet ./...

test:
    go test ./...

lint:
    golangci-lint run ./...

# Build the web UI into web/dist/app; the server binary embeds it.
web:
    cd web && npm ci && npm run build

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

# Speech service (live translation), run natively: on a Mac this is far
# faster than the CPU container. Needs SPEECH_SECRET and a translation
# engine, e.g. TRANSLATE_URL and TRANSLATE_MODEL (see speech/README.md).

# Create the speech venv and download the Piper voices.
speech-setup:
    cd speech && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
    cd speech && .venv/bin/python -m piper.download_voices --data-dir voices $(.venv/bin/python -c "import yaml; print(' '.join(v for l in yaml.safe_load(open('languages.yaml'))['languages'].values() for v in l['voices'].values()))")

# Run the speech service on :8090.
speech:
    cd speech && .venv/bin/python -m app

# Check the speech service's engine settings (no models needed).
speech-unit:
    cd speech && .venv/bin/python -m tests.test_config

# Stream the fixtures through a running speech service and check the translations.
speech-test url="ws://localhost:8090":
    cd speech && .venv/bin/python -m tests.stream_sample {{url}}
