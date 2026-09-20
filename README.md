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
| `JOIN_ONLY`        | `false`                  | Hide room creation on the landing page (join-only); requires `API_KEYS` |
| `ROOM_TTL_DAYS`    | `365`                    | Rooms older than this many days are deleted hourly; live rooms are skipped; `0` keeps rooms forever |
| `ICE_UDP_PORT`     | `5000`                   | Single UDP port for all WebRTC traffic           |
| `EXTERNAL_IPS`     | —                        | Comma-separated public IPs advertised for ICE (NAT) |
| `ICE_SERVERS`      | Google STUN              | JSON array of STUN/TURN servers handed to clients |
| `MAX_PUBLISH_KBPS` | `2500`                   | REMB ceiling per publisher                       |
| `MAX_ROOM_MEMBERS` | `16`                     | Default room member limit                        |
| `ALLOWED_ORIGINS`  | same-origin              | Extra origins allowed on the signaling WebSocket |

## HTTP API

Everything lives under `/api` on the same origin. Creation, listing and
deletion require a bearer key when `API_KEYS` is set.

### Creating rooms from automations

```bash
# One-time: mint an operator key and put it in the server's API_KEYS.
openssl rand -base64 32

# Create a password-protected, named room.
curl -X POST https://meet.example.com/api/rooms \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Standup","password":"hunter2","maxMembers":12}'
```

The response carries everything needed to hand out links (rooms are
immutable; this is the only time the key and token are revealed):

```json
{
  "slug": "abc-def-ghi",
  "name": "Standup",
  "roomKey": "kX9…",
  "privToken": "k5Q…",
  "privPath": "/r/abc-def-ghi?p=k5Q…",
  "privUrl": "https://meet.example.com/r/abc-def-ghi?p=k5Q…#k=kX9…",
  "shortPath": "/r/abc-def-ghi",
  "shortUrl": "https://meet.example.com/r/abc-def-ghi",
  "baseUrl": "https://meet.example.com",
  "maxMembers": 12
}
```

- **Public link**: `shortUrl` — or `${baseUrl}${shortPath}` when
  `BASE_URL` is unset, prefixed with your own origin. Share freely; a
  password room asks for the password in the browser.
- **Privileged link**: `privUrl` — or `${baseUrl}${privPath}#k=${roomKey}`.
  Opens without the password and carries moderator rights — mute, stop
  camera or screen share, kick. Keep it to the host.
- `roomKey` and `privToken` are shown exactly once. Store both to rebuild
  the privileged link later; the server cannot re-mint them.

An hourly janitor deletes rooms older than `ROOM_TTL_DAYS` (a year by
default, matching the session lifetime) along with their sessions,
skipping any room with a live call. Set `ROOM_TTL_DAYS=0` to keep rooms
forever; rooms can always be deleted explicitly with
`DELETE /api/rooms/{slug}`.

### Auth tokens

- **API keys** are static operator secrets you mint yourself
  (`openssl rand -base64 32`) and list in `API_KEYS`. Send them as
  `Authorization: Bearer <key>` or `X-Api-Key`. They gate only room
  creation, listing and deletion.
- **Privileged link tokens** (`privToken`) are minted by room creation
  and stored only as a hash. The browser exchanges one for a moderator
  session automatically when someone opens a privileged link.
- **Join sessions** are minted by `POST /api/rooms/{slug}/auth` — send
  `{"token": …}` (privileged link), an empty body (open room; returns
  the room key) or `{"proof": base64url(PBKDF2-SHA256(password,
  authSalt), 210000 iterations)}` (password room; returns the room key
  sealed with AES-GCM under the password). Sessions are opaque,
  room-scoped and long-lived (a year by default); automations normally
  never need them, since the links above carry everything.

### Public, join-only deployments

Set `API_KEYS` **and** `JOIN_ONLY=true`: the landing page then offers
joining only, and rooms exist solely through the API above. (The server
refuses to start with `JOIN_ONLY` but no `API_KEYS`, which would leave
creation open anyway.)

### Other endpoints

- `GET /api/config` — ICE servers, whether creation needs a key, whether
  the landing page is join-only.
- `GET /api/rooms/{slug}` — public room info; password rooms include
  the salts the browser needs to compute a proof.
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
  derived via HKDF from the room key); chat with AES-GCM. Each frame carries
  its own counter block, so the receiver never depends on local timing.
- Only the codec header the RTP layer and hardware decoders must read stays
  in the clear: the 10-byte VP8 keyframe header (frame tag, start code,
  dimensions), the 3-byte VP8 delta frame tag, the 1-byte Opus TOC. Video
  is pinned to VP8, because H.264 and AV1 packetizers parse the payload
  and cannot carry ciphertext.
- The worker is TypeScript compiled against the WebWorker typings
  (`web/tsconfig.worker.json`), so calling an encoded-frame API a browser
  does not have fails the build instead of silently dropping every frame.

## Development

```bash
just check    # vet + test + lint + web build + go build + browser smoke (what CI runs)
just e2e      # the browser smoke test alone
just run      # local server with a scratch database
just release-preview
```

The Go code must stay clean under `golangci-lint` with every linter enabled
(`default: all`) and under `gopls`. `go test ./...` includes a full WebRTC
media loopback test through the hub and a check that forwarded RTP header
extensions are renumbered to the viewer's extmap.

`just e2e` (`web/e2e/smoke.mjs`) starts a server, points two headless
Chromes with fake cameras at one room and asserts that both receive the
other's audio and video through the E2EE transform with zero dropped
frames and exactly one tile per participant. It needs Chrome on `PATH`
(or `CHROME=/path/to/chrome`) and is the gate that catches what type
checks and unit tests cannot: a pipeline that connects fine and
transmits nothing.

## License

MIT — see [LICENSE](LICENSE).
