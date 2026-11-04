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

- 🔒 **Private by design.** Video, audio and chat are encrypted in your
  browser before they leave it. The server only passes along scrambled
  data it cannot read.
- 🔗 **One link to join.** Rooms get a short, readable link like
  `/r/abc-def-ghi`. No accounts, no apps, no installs: it runs in the
  browser.
- 🔑 **Optional room password.** Lock a room with a password, or hand
  the host a special link that skips the password and adds moderator
  controls.
- 🖥️ **Screen sharing and chat**, with mute and camera controls for
  every participant.
- 🎥 **Recording that stays with you.** The host can record the meeting
  in their own browser and download the video afterwards. The recording
  never touches the server, and everyone sees a badge while it runs.
- 🌐 **Works on tricky networks.** A built-in relay gets people through
  firewalls and corporate networks, including over port 443.
- 📦 **One small program.** A single binary (or Docker image) with its
  own database. No extra services to run.

## How to use it

1. **Create a room** on the home page (or through the [API](#http-api)).
   Give it a name and, if you like, a password.
2. **Share the link.** Send the short link to everyone who should join.
   Keep the *privileged link* for yourself: it opens the room without
   the password and lets you mute, stop cameras or remove people.
3. **Join.** People open the link, pick their camera and microphone, type
   the password if the room has one, and they are in.

> [!TIP]
> The room key travels in the part of the link after `#`, which browsers
> never send to any server. Share the privileged link carefully: anyone
> who has it is a moderator.

## Run your own server

You need a server with a public IP, a domain name, and Docker.

```bash
cp .env.example .env        # fill in DOMAIN, TURN_TLS_HOST, ACME_EMAIL, API_KEYS, EXTERNAL_IPS
docker compose up -d
```

That's it. Traefik fetches TLS certificates and routes `DOMAIN` to the
app (which then runs with `BASE_URL=https://$DOMAIN`) and
`TURN_TLS_HOST` (a second DNS name pointing at the same server) to the
relay. Make sure these ports are open:

| Port         | Used for                       |
| ------------ | ------------------------------ |
| 443/tcp      | the website and relay over TLS |
| 5000/udp     | video and audio                |
| 3478/udp+tcp | the network relay (TURN)       |

Rooms are stored in SQLite under the `data` volume.

Prefer running it without Docker?

```bash
go build ./cmd/server
BASE_URL=https://meet.example.com API_KEYS=s3cret EXTERNAL_IPS=203.0.113.10 ./conference
```

### Settings

All settings are environment variables.

| Variable            | Default         | What it does                                                                              |
| ------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `PORT`              | `8080`          | HTTP listen port                                                                          |
| `BIND`              | all interfaces  | Listen host                                                                               |
| `BASE_URL`          | —               | Public origin such as `https://meet.example.com`, used in room links and link previews; the server refuses to start if it has a path, query or no `http(s)` scheme |
| `PUBLIC_ORIGINS`    | —               | Comma-separated further origins the same server answers on (e.g. `https://meet.example.org`); requests on one of them get links and preview images on that origin instead of `BASE_URL` |
| `DB_PATH`           | `conference.db` | SQLite database path                                                                      |
| `API_KEYS`          | empty           | Comma-separated keys needed to create, list and delete rooms; empty means anyone may create |
| `JOIN_ONLY`         | `false`         | Hide room creation on the home page so people can only join; requires `API_KEYS`          |
| `OPEN_CREATE_HOSTS` | —               | Hostnames where anyone may create rooms despite `API_KEYS`/`JOIN_ONLY`                    |
| `ROOM_TTL_DAYS`     | `365`           | Delete rooms older than this (checked hourly, live rooms are skipped); `0` keeps them forever |
| `ICE_UDP_PORT`      | `5000`          | The single UDP port for all video and audio                                               |
| `EXTERNAL_IPS`      | —               | Comma-separated public IPs to advertise when behind NAT                                   |
| `TURN_PORT`         | `3478`          | UDP and TCP port of the built-in relay                                                    |
| `TURN_TLS_HOST`     | —               | Hostname whose port 443 forwards to the relay over TLS                                    |
| `MAX_PUBLISH_KBPS`  | `2500`          | Upload bandwidth cap per participant                                                      |
| `MAX_ROOM_MEMBERS`  | `16`            | Default maximum people per room                                                           |
| `TRUSTED_PROXIES`   | —               | Comma-separated IPs or CIDRs of reverse proxies whose `X-Forwarded-For` names the real client, so rate limits apply per visitor instead of per proxy |
| `ALLOWED_ORIGINS`   | same origin     | Extra origins allowed to connect to the signaling WebSocket                               |
| `SLACK_SIGNING_SECRET` | —            | Enables the [`/meet` Slack command](#start-meetings-from-slack); requires `BASE_URL`      |

### Who can create rooms?

- **Anyone** (default): leave `API_KEYS` empty.
- **Only people or tools with a key:** set `API_KEYS`. The home page asks
  for the key when creating a room.
- **Nobody from the website, rooms come only from your automations:** set
  `API_KEYS` **and** `JOIN_ONLY=true`. The home page then only offers
  joining. The server refuses to start with `JOIN_ONLY` but no
  `API_KEYS`, since creation would be open anyway.
- **Mixed, per domain:** when one server answers several domains,
  `OPEN_CREATE_HOSTS` lets anyone create rooms on the listed hosts while
  the rest stay locked:

  ```bash
  API_KEYS=s3cret JOIN_ONLY=true OPEN_CREATE_HOSTS=stubbe.dev ./conference
  ```

  All domains share one database, so links work on any of them. List
  the extra domains in `PUBLIC_ORIGINS` so each one's API links and
  link previews stay on that domain.

Creating rooms without a key is limited to 10 in a row per visitor,
then one a minute; key holders are never limited. Behind a reverse
proxy, set `TRUSTED_PROXIES` to its address so each visitor is counted
separately (the bundled compose file already does).

Old rooms are cleaned up automatically after `ROOM_TTL_DAYS`, together
with their sessions. A room in use is never deleted.

### Start meetings from Slack

Type `/meet` (or `/meet Design review`) in any Slack channel and the
server creates a room and posts its link to the channel. You also get
the moderator link in a message only you can see.

1. At [api.slack.com/apps](https://api.slack.com/apps), choose **Create
   New App → From a manifest**, pick your workspace and paste this,
   with your own address in `url`:

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

2. **Install to Workspace**, then copy **Signing Secret** from *Basic
   Information* into the server's `SLACK_SIGNING_SECRET` and restart it.
   `BASE_URL` must be set too, since Slack needs full links.

The server checks Slack's signature on every request and ignores
anything older than five minutes.

> [!NOTE]
> Rooms made from Slack have no password, so the server holds their key
> (see [How privacy works](#how-privacy-works)). The moderator link
> reaches you through Slack, so Slack can see it too.

## How privacy works

- Every room has its own 256-bit key. Your browser uses it to encrypt
  each video and audio frame (AES-CTR, in a WebRTC Encoded Transform) and
  each chat message (AES-GCM) before sending it.
- **Password rooms:** the server never learns the key. It stores only a
  PBKDF2 proof of the password and the room key locked (AES-GCM) with
  that password. Your browser checks the password and unlocks the key
  itself.
- **Rooms without a password:** the server hands the key to whoever
  joins. Traffic is still protected from anyone on the network, but not
  from whoever runs the server. Use a password if that matters to you.
- **Privileged links** carry the key after the `#`, which browsers never
  send to a server.
- Joining is authorized separately from the media key, through a session
  issued by `/auth`.

<details>
<summary>Technical details</summary>

- The frame key is derived from the room key with HKDF. Each frame
  carries its own counter block, so receivers never depend on local
  timing.
- Only the codec header the RTP layer and hardware decoders must read
  stays in the clear: the 10-byte VP8 keyframe header (frame tag, start
  code, dimensions), the 3-byte VP8 delta frame tag, and the 1-byte Opus
  TOC. Video is pinned to VP8, because H.264 and AV1 packetizers parse
  the payload and cannot carry ciphertext.
- The encryption worker is TypeScript compiled against the WebWorker
  typings (`web/tsconfig.worker.json`), so calling an encoded-frame API a
  browser does not have fails the build instead of silently dropping
  every frame.
- The relay (TURN) mints credentials per member in the signaling welcome
  and revokes them when the member leaves. It only forwards to the SFU
  itself, so it cannot be abused as an open proxy.
- Recording composites every tile plus one mixed audio track in the
  host's browser and mirrors the host's layout (pinned tile large, others
  in a strip, screen shares pinned automatically). Long calls stream to
  the origin-private file system so memory stays flat. The container
  follows the browser: WebM on Chrome and Firefox, MP4 on Safari.

</details>

## HTTP API

Everything lives under `/api` on the same address. Creating, listing and
deleting rooms requires a key when `API_KEYS` is set.

### Create a room from a script

```bash
# Once: make a key and add it to the server's API_KEYS.
openssl rand -base64 32

# Create a named, password-protected room.
curl -X POST https://meet.example.com/api/rooms \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"Standup","password":"hunter2","maxMembers":12}'
```

The response has everything you need to hand out links:

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

- **Public link:** `shortUrl`, or `${baseUrl}${shortPath}` when
  `BASE_URL` is unset (prefixed with your own address). Share it freely;
  a password room asks for the password in the browser.
- **Privileged link:** `privUrl`, or `${baseUrl}${privPath}#k=${roomKey}`.
  Opens without the password and gives moderator rights: mute, stop
  camera or screen share, remove people. Keep it to the host.

> [!IMPORTANT]
> `roomKey` and `privToken` are shown **only once**. Rooms can't be
> changed after creation, and the server can't recreate these values.
> Store both if you need to rebuild the privileged link later.

### Keys and sessions

- **API keys** are secrets you make yourself and list in `API_KEYS`.
  Send one as `Authorization: Bearer <key>` or `X-Api-Key`. They are
  only needed to create, list and delete rooms.
- **Privileged link tokens** (`privToken`) are created with the room and
  stored only as a hash. The browser trades one for a moderator session
  when someone opens a privileged link.
- **Join sessions** come from `POST /api/rooms/{slug}/auth`. Send
  `{"token": …}` for a privileged link, an empty body for an open room
  (returns the room key), or `{"proof": base64url(PBKDF2-SHA256(password,
  authSalt), 210000 iterations)}` for a password room (returns the room
  key sealed with AES-GCM under the password). Sessions are tied to one
  room and last a year by default. Automations normally never need them,
  since the links carry everything.

### Other endpoints

| Endpoint                   | Purpose                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `GET /api/config`          | Whether creating needs a key, and whether the home page is join-only |
| `GET /api/rooms/{slug}`    | Public room info; password rooms include the salts the browser needs |
| `GET /api/rooms`           | List rooms (API key)                                              |
| `DELETE /api/rooms/{slug}` | Delete a room (API key)                                           |

## Under the hood

One Go binary serves the website, the REST API, signaling and a
Galène-style SFU (selective forwarding unit):

- One upstream connection per publisher and one downstream connection per
  viewer, trickle ICE, keyframe requests, NACK and receiver-report
  interceptors, and a REMB bandwidth ceiling, all on a single UDP port.
- Simulcast cameras, with each viewer getting the layer that fits.
- A built-in TURN relay over UDP, TCP and TLS on 443. No coturn and no
  third-party STUN.
- SQLite storage in pure Go (no CGO), with the web UI embedded.

## Development

```bash
just check    # vet + test + lint + web build + go build + browser smoke (what CI runs)
just e2e      # only the browser smoke test
just run      # local server with a scratch database
just release-preview
```

The Go code must stay clean under `golangci-lint` with every linter
enabled (`default: all`) and under `gopls`. `go test ./...` includes a
full WebRTC media loopback test through the hub, and a check that
forwarded RTP header extensions are renumbered to each viewer's extmap.

`just e2e` (`web/e2e/smoke.mjs`) starts a server built with the race
detector and points headless Chromes with fake cameras at one room. It
checks that both browsers receive each other's audio and video through
the encryption transform with zero dropped frames and exactly one tile
per participant. Then it pins tiles, checks simulcast layer switching,
drops a browser's signaling and restarts the server mid-call (both must
reconnect), records (the file must contain the other participant's
voice), and forces a call through the TURN relay over UDP and TCP. It
needs Chrome on `PATH` (or `CHROME=/path/to/chrome`), `ffmpeg` and a
non-loopback IPv4 address. It is the gate that catches what type checks
and unit tests can't: a call that connects fine and transmits nothing.

### Monitoring a deployment

`.github/workflows/monitor.yml` places real calls against a deployment
every 15 minutes (`web/e2e/monitor.mjs`): direct, through TURN over UDP
and TCP, and over TLS on 443 when `TURN_TLS_HOST` is set. Each run
creates its rooms with an operator key and deletes them afterwards. A
failed run is the alert, since GitHub notifies about failed scheduled
workflows.

To turn it on:

1. Add a dedicated key to the server's `API_KEYS`.
2. Set the repository variable `MONITOR_URL` (e.g. `https://meet.example.com`).
3. Set the repository secret `MONITOR_API_KEY`.

Without `MONITOR_URL` the workflow does nothing. GitHub pauses scheduled
workflows in repositories with no activity for 60 days.

## License

MIT, see [LICENSE](LICENSE).
