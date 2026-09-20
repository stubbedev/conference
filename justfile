# conference dev / release tasks.
# Mirrors the CI gates (go vet/test/lint/build + web build) so a green
# `just check` predicts green CI.

default:
    @just --list

# vet + test + lint + web build + go build + browser smoke test (what
# ci.yml runs).
check: vet test lint web build e2e

vet:
    go vet ./...

test:
    go test ./...

lint:
    golangci-lint run ./...

# Build the web UI into web/dist; the server binary embeds it.
web:
    cd web && npm ci && npm run build

build:
    CGO_ENABLED=0 go build -o /dev/null ./cmd/server

fmt:
    gofmt -w .

# Run backend (air hot reload) + vite dev server (HMR on
# http://localhost:5173) with a scratch database — the quickest way to
# try it locally. Ctrl+C stops both. air rebuilds and restarts the
# backend on every Go change and passes this shell's environment through
# to it: :18080 so it never fights other services for 8080, an ephemeral
# ICE port, and a scratch SQLite in /tmp. vite proxies /api and /ws to
# it. The toolchain (go, air, just, node) comes from the flake dev shell
# — see flake.nix.
dev:
    #!/usr/bin/env bash
    set -euo pipefail
    (cd web && [ -d node_modules ] || npm ci)
    export PORT=18080
    export ICE_UDP_PORT=0
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
# built server and must exchange E2EE audio and video. Needs Chrome on
# PATH (or CHROME=/path/to/chrome).
e2e:
    node web/e2e/smoke.mjs

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

# Tag the current commit and push the tag (the tag push triggers
# .github/workflows/release.yml, which publishes the Docker image).
release level:
    #!/usr/bin/env bash
    set -euo pipefail
    if ! git diff --quiet || ! git diff --cached --quiet; then
        echo "working tree is dirty — commit or stash first" >&2
        exit 1
    fi
    v="$(git describe --tags --abbrev=0 2>/dev/null || echo v0.0.0)"
    IFS=. read -r maj min pat <<<"${v#v}"
    case "{{level}}" in
        patch) next="v$maj.$min.$((pat + 1))" ;;
        minor) next="v$maj.$((min + 1)).0" ;;
        major) next="v$((maj + 1)).0.0" ;;
        *) echo "level must be patch, minor or major" >&2; exit 1 ;;
    esac
    git tag "$next"
    git push origin "$next"
    echo "pushed $next"
