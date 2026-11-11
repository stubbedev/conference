<p align="center">
  <img src="web/public/logo.svg" width="96" height="96" alt="">
</p>

<h1 align="center">conference</h1>

<p align="center">
  Private video meetings you host yourself.<br>
  Create a room, share the link, talk. Nobody in between can see or hear you, not even the server.
</p>

---

## What you get

- 🔒 **End-to-end encrypted.** Video, audio and chat are encrypted in the
  browser; the server forwards data it cannot read.
- 🔗 **One link, no installs.** Rooms get a short link like
  `/r/abc-def-ghi`. No accounts, no apps.
- 🔑 **Optional password**, plus a privileged link that skips it and adds
  moderator controls.
- 🖥️ **Screen sharing and chat**, with mute and camera controls.
- 🫥 **Background blur in the browser.** The camera never leaves the
  machine for segmentation.
- 🎥 **Local recording.** One participant at a time records in their own
  browser; everyone sees a badge while it runs.
- 🗣️ **Live translation.** Subtitles and a translated voice in each
  listener's language, on engines you run or in every browser. See
  [Live translation](#live-translation).
- 🌐 **Works behind firewalls**, through a built-in relay, including over
  port 443.
- 📦 **One binary** (or Docker image) with its own SQLite database.

## How to use it

1. **Create a room** on the home page or through the [API](#http-api),
   optionally with a password.
2. **Share the short link.** Keep the *privileged link* for yourself: it
   skips the password and lets you mute, stop cameras or remove people.
3. **Join.** Device choices and mute states are remembered for next time.

> [!TIP]
> The room key travels after the `#` in the link, which browsers never
> send to a server. Anyone with the privileged link is a moderator.

## Run your own server

You need a server with a public IP, a domain name and Docker.

```bash
cp .env.example .env        # fill in DOMAIN, TURN_TLS_HOST, ACME_EMAIL, API_KEYS, EXTERNAL_IPS
docker compose up -d
```

Traefik fetches certificates and routes `DOMAIN` to the app and
`TURN_TLS_HOST` (a second DNS name for the same server) to the relay.
Open these ports:

| Port         | Used for                       |
| ------------ | ------------------------------ |
| 443/tcp      | the website and relay over TLS |
| 5000/udp     | video and audio                |
| 3478/udp+tcp | the relay (TURN)               |

Media sockets ask for a 4 MiB receive buffer, but Linux grants at most
`net.core.rmem_max` (208 KiB by default). The server logs a warning and
`GET /api/healthz` reports what it got. Raise the limit on the host (it
cannot be set from a container), persist it in `/etc/sysctl.d`, and
restart the server:

```bash
sysctl -w net.core.rmem_max=4194304
```

Without Docker:

```bash
go build -o conference ./cmd/server
BASE_URL=https://meet.example.com API_KEYS=s3cret EXTERNAL_IPS=203.0.113.10 ./conference
```

### Settings

All settings are environment variables.

| Variable                | Default         | What it does |
| ----------------------- | --------------- | ------------ |
| `PORT`                  | `8080`          | HTTP port; `0` lets the kernel pick. Once all ports are bound, the server prints `ready {…}` with the bound addresses on stdout |
| `BIND`                  | all interfaces  | Listen host |
| `BASE_URL`              | —               | Public origin, e.g. `https://meet.example.com`, used in links and previews |
| `PUBLIC_ORIGINS`        | —               | Further origins the server answers on; links and previews follow the request's origin |
| `DB_PATH`               | `conference.db` | SQLite database path |
| `API_KEYS`              | empty           | Keys needed to create, list and delete rooms; empty means anyone may create |
| `JOIN_ONLY`             | `false`         | Hide room creation on the home page; requires `API_KEYS` |
| `OPEN_CREATE_HOSTS`     | —               | Hostnames where anyone may create rooms despite `API_KEYS`/`JOIN_ONLY` |
| `ROOM_TTL_DAYS`         | `365`           | Delete rooms nobody joined for this long; `0` keeps them |
| `ICE_UDP_PORT`          | `5000`          | The one UDP port for all media; `0` lets the kernel pick one per interface |
| `EXTERNAL_IPS`          | —               | Public IPs to advertise behind NAT |
| `TURN_PORT`             | `3478`          | UDP and TCP port of the relay; `0` lets the kernel pick |
| `TURN_TLS_HOST`         | —               | Hostname whose port 443 forwards to the relay over TLS |
| `MAX_ROOM_MEMBERS`      | `16`            | Default room size limit |
| `TRUSTED_PROXIES`       | —               | Reverse proxies whose `X-Forwarded-For` is trusted, so rate limits apply per visitor |
| `ALLOWED_ORIGINS`       | same origin     | Extra origins allowed on the signalling WebSocket |
| `SLACK_SIGNING_SECRET`  | —               | Enables the [`/meet` Slack command](#start-meetings-from-slack); requires `BASE_URL` |
| `SPEECH_RUNTIME`, `SPEECH_MODEL_*`, `TRANSCRIBE_*`, `TRANSLATE_*`, `VOICE_*` | — | [Live translation](#live-translation); every setting is in [docs/live-translation.md](docs/live-translation.md) |

### Who can create rooms?

- **Anyone:** leave `API_KEYS` empty (the default).
- **Key holders only:** set `API_KEYS`; the home page asks for a key.
- **Automations only:** set `API_KEYS` and `JOIN_ONLY=true`.
- **Per domain:** `OPEN_CREATE_HOSTS` opens creation on the listed hosts
  while the others stay locked. List the extra domains in
  `PUBLIC_ORIGINS` so their links stay on that domain.

Without a key, a visitor may create 10 rooms in a row, then one a
minute. Behind a reverse proxy, set `TRUSTED_PROXIES` (the bundled
compose file does). Rooms in use, or joined within `ROOM_TTL_DAYS`, are
never deleted.

### Start meetings from Slack

`/meet` (or `/meet Design review`) in a channel creates a room, posts its
link, and sends you the moderator link privately.

1. At [api.slack.com/apps](https://api.slack.com/apps), choose **Create
   New App → From a manifest** and paste this, with your own `url`:

   ```yaml
   display_information:
     name: conference
   features:
     bot_user:
       display_name: conference
       always_online: false
     slash_commands:
       - command: /meet
         url: https://meet.example.com/api/slack/meet
         description: Start a meeting and post its link
         usage_hint: "[meeting name]"
         should_escape: false
   oauth_config:
     scopes:
       bot:
         - commands
   settings:
     socket_mode_enabled: false
   ```

2. **Install to Workspace**, copy the **Signing Secret** into
   `SLACK_SIGNING_SECRET`, and restart. `BASE_URL` must be set.

> [!NOTE]
> Slack rooms have no password, so the server holds their key (see
> [How privacy works](#how-privacy-works)), and Slack sees the moderator
> link.

### Live translation

Everyone picks the language they speak (it starts as the browser's) and
whether they want subtitles, a translated voice, or both. When someone
turns on **Live translation**, each speaker's words reach every listener
in the listener's language, as subtitles on the speaker's tile and as a
translated voice in place of their own. A recording uses the recorder's
language. A host can correct a participant's language from the
participants list.

It runs on one of two runtimes:

- **On the server** (default): the server detects speech and calls
  engines you configure, such as whisper.cpp, Ollama, an OpenAI-compatible
  voice server, or any OpenAI-compatible API:

  ```bash
  TRANSLATE_URL=http://host.docker.internal:11434 TRANSLATE_MODEL=<model> \
  TRANSCRIBE_URL=… TRANSCRIBE_MODEL=… VOICE_URL=… VOICE_MODEL=… VOICE_NAME=… docker compose up -d
  ```

- **In the browser** (`SPEECH_RUNTIME=browser`): every participant's
  browser runs the models on WebGPU, or on the CPU without one, so no GPU
  server is needed. The server fetches the model files from Hugging Face
  on first use and caches them in `SPEECH_MODEL_DIR`, bounded by
  `SPEECH_MODEL_CACHE_MAX`. Browsers only ever talk to your server.

35 languages are supported: English and the national languages of Europe
that Whisper transcribes. On the server runtime, the app offers no
translation until all three engines are set, and `/api/config` names the
unset variables.
[docs/live-translation.md](docs/live-translation.md) covers engines,
models, settings and where data goes.

## How privacy works

- Every room has its own 256-bit key. The browser encrypts each media
  frame (AES-CTR, in a WebRTC Encoded Transform) and each chat message
  (AES-GCM) before sending it.
- **Password rooms:** the server never learns the key. It stores a PBKDF2
  proof of the password and the key sealed with it; the browser unlocks
  the key itself.
- **Rooms without a password:** the server hands the key to whoever joins.
  Traffic is protected from the network, not from whoever runs the server.
- **Privileged links** carry the key after the `#`.
- **Live translation** on the server runtime sends each speaker's audio to
  the server and its engines, which hear it in the clear (and so does a
  public engine's provider). Nothing is logged or written to disk. On the
  browser runtime, audio never leaves the participant's machine. Either
  way, subtitles and translated voices go back into the room end-to-end
  encrypted.

<details>
<summary>Technical details</summary>

- The frame key is derived from the room key with HKDF; each frame carries
  its own counter block.
- Only what the RTP layer and decoders must read stays in the clear: the
  first 10 bytes of a keyframe, 3 of a delta frame, and the 1-byte Opus
  TOC. Video is VP8 or VP9, because H.264 and AV1 packetizers cannot carry
  ciphertext.
- The relay mints per-member credentials, revokes them when the member
  leaves, and forwards only to the SFU, so it is not an open proxy.
- Recording composites the call's layout and mixed audio in the
  recorder's browser and streams long calls to the origin-private file
  system. The file is WebM on Chrome and Firefox and MP4 on Safari.
- Screen shares are sent as detailed content at up to 60 fps and full
  resolution, VP9 where the browser can simulcast it and VP8 elsewhere, in
  a fluid and a slow encoding, so a viewer on a poor link gets the slow one
  without holding the share back for others.
- Background blur uses MediaPipe's selfie segmentation, served from this
  app (`/vision/`, about 15 MB), never a CDN. The SFU only relays the
  blurred picture.

</details>

## HTTP API

Everything is under `/api`. Creating, listing and deleting rooms needs a
key when `API_KEYS` is set, sent as `Authorization: Bearer <key>` or
`X-Api-Key`.

```bash
curl -X POST https://meet.example.com/api/rooms \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Standup","password":"hunter2","maxMembers":12}'
```

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

- **Public link:** `shortUrl`. Share it freely; a password room asks for
  the password.
- **Privileged link:** `privUrl`. Opens without the password, with
  moderator rights. Keep it to the host.

> [!IMPORTANT]
> `roomKey` and `privToken` are returned **only once** and cannot be
> recovered. Store them if you need to rebuild the privileged link.

Joining goes through `POST /api/rooms/{slug}/auth`, which issues a
session for one room: `{"token": …}` for a privileged link, an empty body
for an open room, or `{"proof": …}` (PBKDF2-SHA256, 210 000 iterations,
over the room's `authSalt`) for a password room. The links handle this,
so automations never need it.

| Endpoint                   | Purpose |
| -------------------------- | ------- |
| `GET /api/config`          | Whether creating needs a key, whether the home page is join-only, and what live translation offers |
| `GET /api/healthz`         | Liveness, and the receive buffer the media sockets got |
| `GET /api/rooms/{slug}`    | Public room info, including the salts a password room needs |
| `GET /api/rooms`           | List rooms (API key) |
| `DELETE /api/rooms/{slug}` | Delete a room (API key) |

## Under the hood

One Go binary serves the website, the API, signalling, a selective
forwarding unit (SFU), a TURN relay over UDP, TCP and TLS, and the speech
service, with SQLite in pure Go and the web UI embedded.

- Each publisher has one upstream connection, plus one for a screen share;
  each viewer has one downstream connection per source. All media shares
  one UDP port.
- Bandwidth comes from measurement, not caps. The camera's upload uses
  transport-wide congestion control; the share's upload follows the
  server's estimate, which stays high while the screen is still so the
  next scroll is not starved.
- Cameras and shares are simulcast. Each viewer gets the layer that fits
  its layout and connection, and climbs back up after a bad stretch.

## Development

```bash
just check            # every gate CI runs: vet, tests, lint, web build, and the browser tests
just run              # local server with a scratch database
just e2e              # browser smoke test
just e2e-share        # screen share scrolled in bursts, from Chrome and Firefox
just e2e-share-start  # a share started and stopped repeatedly
just e2e-translate    # live translation with stand-in engines
just speech-test      # the speech fixtures through the configured engines
```

Go must stay clean under `golangci-lint` with every linter enabled.
`go test ./...` includes a full WebRTC loopback through the SFU.

`just e2e` (`web/e2e/smoke.mjs`) builds the server with the race detector
and drives headless Chromes with fake cameras through one room. It checks
that media flows both ways through the encryption with nothing dropped,
then pins tiles and switches simulcast layers, shares a screen, drops
signalling, restarts the server, records, and forces the call through the
relay over UDP and TCP. It needs Chrome (or `CHROME=`), `ffmpeg` and a
non-loopback IPv4 address. The share tests also need Firefox (or
`FIREFOX=`). Every test starts its own server on kernel-picked ports, so
several can run side by side.

### Live translation locally

```bash
just translate-demo openai   # you and a guest speaking from a recording
just translate-lan openai    # two computers on one network, over HTTPS on :8443
```

Without `openai`, the demos use your own engines from `TRANSLATE_URL`,
`TRANSCRIBE_URL` and `VOICE_URL`. `openai` (with `OPENAI_API_KEY`) sends
the call's audio and text to OpenAI, so use it only for test
conversations.

### Monitoring a deployment

`.github/workflows/monitor.yml` places real calls against a deployment
every 15 minutes: direct, through the relay over UDP and TCP, and over TLS
on 443 when `TURN_TLS_HOST` is set. A failed run is the alert. To turn it
on, add a dedicated key to `API_KEYS`, set the repository variable
`MONITOR_URL`, and set the secret `MONITOR_API_KEY`.

## License

MIT, see [LICENSE](LICENSE).
