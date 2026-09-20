# conference

Self-hosted video meetings with a Google-Meets-style flow: create a room,
share the short link, talk. One Go binary serves the WebRTC SFU, signaling,
the REST API and the web UI — and it only ever relays ciphertext, because
media and chat are encrypted end-to-end in the browser.

## Features

- **End-to-end encrypted media and chat.** Every room has a 256-bit key.
  Video and audio frames are encrypted with a WebRTC Encoded Transform
  (AES-CTR) and chat messages with AES-GCM, both derived from the room key
  inside your browser. The server never holds media keys for password rooms
  and relays ciphertext it cannot read.
- **Meet-style room flow.** Create a room, copy the short link
  (`/r/abc-def-ghi`), share it. Optionally set a password: the short link
  then asks for it, while a **privileged link** (token + key carried in the
  URL fragment, which browsers never send to the server) opens the room
  without one.
- **API-first rooms.** Rooms are created over REST and are immutable once
  created — even the operator can only delete them, not edit them.
- **Screen sharing**, mic/camera controls with per-member state,
  end-to-end-encrypted chat.
- **Galène-style SFU.** One upstream peer connection per publisher, one
  downstream connection per subscriber, trickle ICE, keyframe requests,
  NACK/receiver-report interceptors and a REMB bandwidth ceiling — all on a
  single UDP port.
- **One binary.** SQLite storage (pure Go, no CGO), the web UI embedded.

## Quick start

```bash
cp .env.example .env        # set BASE_URL, ACME_EMAIL, API_KEYS, EXTERNAL_IPS
docker compose up -d
```

Traefik terminates TLS and routes `BASE_URL` to the server; UDP port 5000
carries the WebRTC ICE mux and must stay reachable. Rooms live in SQLite
under the `data` volume.

Or run it bare:

```bash
go build ./cmd/server
BASE_URL=meet.example.com API_KEYS=s3cret EXTERNAL_IPS=203.0.113.10 ./conference
```

## Configuration (environment)

| Variable           | Default                  | Meaning                                          |
| ------------------ | ------------------------ | ------------------------------------------------ |
| `PORT`             | `8080`                   | HTTP listen port                                 |
| `BIND`             | all interfaces           | Listen host                                      |
| `BASE_URL`         | —                        | Public origin, used in created links             |
| `DB_PATH`          | `conference.db`          | SQLite database path                             |
| `API_KEYS`         | empty                    | Comma-separated bearer keys for room creation/deletion; empty = anyone may create |
| `ICE_UDP_PORT`     | `5000`                   | Single UDP port for all WebRTC traffic           |
| `EXTERNAL_IPS`     | —                        | Comma-separated public IPs advertised for ICE (NAT) |
| `ICE_SERVERS`      | Google STUN              | JSON array of STUN/TURN servers handed to clients |
| `MAX_PUBLISH_KBPS` | `2500`                   | REMB ceiling per publisher                       |
| `MAX_ROOM_MEMBERS` | `16`                     | Default room member limit                        |
| `ALLOWED_ORIGINS`  | same-origin              | Extra origins allowed on the signaling WebSocket |

## HTTP API

```bash
# Create a room (with a password). Immutable once created.
curl -X POST https://host/api/rooms \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"name":"Standup","password":"hunter2"}'

# → {"slug":"abc-def-ghi","roomKey":"…","privToken":"…",
#    "privPath":"/r/abc-def-ghi?p=…","shortPath":"/r/abc-def-ghi", …}
```

- `GET /api/config` — ICE servers + whether an API key is required.
- `GET /api/rooms/{slug}` — public room info; for password rooms it
  includes the salts the browser needs to compute a proof.
- `POST /api/rooms/{slug}/auth` — join authorization. Send either
  `{"token": "…"}` (privileged link), nothing at all (open room; returns
  the room key) or `{"proof": base64url(PBKDF2-SHA256(password, authSalt),
  210000 iterations)}` (password room; returns the room key sealed with
  AES-GCM under the password). Returns a session for the signaling
  WebSocket.
- `GET /api/rooms` / `DELETE /api/rooms/{slug}` — operator endpoints (API key).

## How the end-to-end encryption works

- Joining is authorized by a session from `/auth`; media keys are separate.
- **Password rooms** are server-blind: the server stores only a PBKDF2
  proof of the password and the room key sealed (AES-GCM) under that
  password. The browser computes the proof, unseals the key locally.
- **Open rooms** have no password, so the server hands the room key to
  joiners; the media is still protected against network eavesdroppers, but
  not against the server operator.
- **Privileged links** carry the key in the URL fragment (`#k=…`), which
  browsers never transmit.
- Frames are encrypted with AES-CTR in an Encoded Transform worker (key
  derived via HKDF from the room key); chat with AES-GCM. The first byte of
  each frame stays in the clear so RTP payload descriptors survive.

## Development

```bash
just check    # vet + test + lint + web build + go build (what CI runs)
just run      # local server with a scratch database
just release-preview
```

The Go code must stay clean under `golangci-lint` with every linter enabled
(`default: all`) and under `gopls`. `go test ./...` includes a full WebRTC
media loopback test through the hub.

## License

MIT — see [LICENSE](LICENSE).
