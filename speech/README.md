# Speech service

The engine behind live translation: a small Go service (`cmd/speech`)
that each speaking member's browser streams its own microphone to while a
host has live translation switched on. For every finished sentence it
sends back subtitles in the speaker's language and every listener's
language, and a translated voice per listener language. The conference
server never sees any of it; it only hands out the tokens.

```
browser ──16 kHz audio──► voice detection ─► transcription ─► translation ─► voice
        ◄── subtitles, translated voice ──────────────────────────────────────┘
```

- **One static binary.** Voice detection runs in the service itself: the
  Silero VAD model in pure Go
  ([go-silerovad](https://github.com/vithnilica/go-silerovad), MIT), so
  the binary needs no cgo, Python or model download, and the Docker image
  is about 19 MB on distroless. Transcription, translation and the voice
  are HTTP engines you choose.
- **Nothing kept.** No audio or text is logged or written to disk: it
  lives in memory for as long as it takes to translate a sentence.
- **One stream per member.** See [Streams](#streams).
- **35 languages**, each translated with the form of address a business
  call uses. See [Languages](#languages).

## Run it

```bash
SPEECH_SECRET=s3cret TRANSCRIBE_MODEL=… TRANSLATE_MODEL=… VOICE_MODEL=… VOICE_NAME=… just speech
```

Or in Docker (the build context is the repository root):

```bash
cd speech
SPEECH_SECRET=s3cret TRANSLATE_URL=http://ollama:11434 TRANSLATE_MODEL=… docker compose up -d
```

Then point the conference server at it with the same secret:
`SPEECH_URL=wss://speech.example.com/v1/stream` (behind TLS, since the
browsers connect to it directly) and `SPEECH_SECRET=s3cret`. If the server
can't reach that public address itself, set `SPEECH_STATUS_URL` to an
internal one, e.g. `http://speech:8090/v1/status`.

`GET /v1/status` says, without a token and without anything secret,
whether every engine is set up, whether any sends data off this network
and which languages are available. The conference app shows live
translation greyed out, with what is missing, until everything is ready.
The service also logs, at start, every engine that is not set up or that
leaves the network, and whether interim subtitles are on. Engine URLs are
checked at start (http or https, with a host) and only ever logged with
any password hidden.

## Settings

`.env.example` lists every setting. No engine has a vendor's model as its
default.

| Setting | Default | |
|---|---|---|
| `SPEECH_SECRET` | (required) | Shared with the conference server, which signs members' tokens with it |
| `HOST`, `PORT` | `0.0.0.0`, `8090` | Where the service listens |
| `TRANSCRIBE_URL`, `TRANSCRIBE_API_KEY`, `TRANSCRIBE_MODEL` | OpenAI, `OPENAI_API_KEY`, none | Transcription: an OpenAI-compatible `/audio/transcriptions` |
| `TRANSCRIBE_RESPONSE_FORMAT` | `json` | `verbose_json` drops what Whisper marks as non-speech (below) |
| `INTERIM_MS` | 600, or 0 for an external transcription engine | How often to subtitle a sentence still being spoken; 0 turns it off |
| `TRANSLATE_PROVIDER` | `ollama` | `ollama` (`/api/chat`) or `openai-compatible` (`/chat/completions`) |
| `TRANSLATE_URL`, `TRANSLATE_API_KEY`, `TRANSLATE_MODEL` | `http://localhost:11434` (Ollama) or OpenAI, `OPENAI_API_KEY` (OpenAI-compatible only), none | The translation engine |
| `VOICE_URL`, `VOICE_API_KEY`, `VOICE_MODEL` | OpenAI, `OPENAI_API_KEY`, none | The voice: an OpenAI-compatible `/audio/speech` that returns WAV |
| `VOICE_NAME` | none | The voice for languages without their own `voices` |
| `OPENAI_API_KEY` | none | The key for every OpenAI-compatible engine without its own |
| `INTERNAL_DOMAINS` | none | Domains on your network, e.g. `corp.example.com`, so their engines don't count as external |
| `GLOSSARY` | none | Term translations the translator must use, e.g. `Kontainer = Kontainer` |
| `LANGUAGES_FILE` | built in | Your own language list (below) |
| `ENGINES` | `real` | `fake` swaps all three engines for stand-ins, for tests |

OpenAI-compatible means OpenAI itself, Azure OpenAI, Mistral, Groq or
OpenRouter, or a server of your own:

- **Transcription on your own machine:** whisper.cpp's `whisper-server`
  (C++), started with `--inference-path /v1/audio/transcriptions`.
- **Translation on your own machine:** any model Ollama serves. The
  service asks Ollama not to think before it answers, so a reasoning
  model doesn't delay the subtitles.
- **Voice on your own machine:** any server that speaks OpenAI's
  `/audio/speech` and can return `wav`. The sample rate comes from the
  WAV header, so there is nothing to set.

**Where data goes.** An engine counts as external, and the app says so,
unless its host is loopback, a private or link-local address, a bare host
name, a `.local`, `.internal` or `.lan` name, or under one of
`INTERNAL_DOMAINS`.

**Interim subtitles**, shown while someone is still talking, transcribe
the growing sentence every `INTERIM_MS`. Each is a call that resends the
whole sentence so far, so they are on when transcription runs on your
network and off when it goes to an external service, where every call is
billed.

**Invented sentences.** Whisper sometimes invents one ("Thank you for
watching.") for noise it mistakes for speech. With
`TRANSCRIBE_RESPONSE_FORMAT=verbose_json` the service drops every segment
Whisper itself marks as non-speech (no-speech probability above 0.6 and
average log-probability below −1, Whisper's own rule). whisper.cpp's
`whisper-server` and OpenAI's `whisper-1` support it; OpenAI's gpt-4o
transcription models accept only `json`, the default.

**Sentences** end after 400 ms of silence (160 ms once someone has spoken
for 3 s, so fast talkers are cut at their pauses) and at 12 s at the
latest.

## Streams

A token admits one member of one room, and a stream carries only that
member's speech: audio for any other speaker ends the stream with a
policy-violation status. A member has one stream at a time: a new
connection replaces the old one, which is closed the same way, so a lost
connection's replacement takes over at once and a leaked token cannot
open more streams, each spending on paid engines.

A stream translates into the languages its `hello` names, and into
nothing before it. If the browser goes away, the stream ends at once,
and any sentence still being translated for it is dropped.

## Languages

35 languages are included: English and the national languages of Europe
that Whisper transcribes (Irish is not among them). The list is
[`internal/speech/service/languages.json`](../internal/speech/service/languages.json),
built into the binary; the conference app takes its language list from
the service. Each entry has a Whisper language code and, where the
language has a formal and an informal "you", the form of address the
translation uses (formal for most; "du" in the Scandinavian languages
and "sinä" in Finnish, as is usual at work there).

To change the list, or to give each language its own voices, point
`LANGUAGES_FILE` at a file of the same shape. `voices` maps the speaker's
voice choice to the voice engine's voice name:

```json
[
  { "code": "en", "name": "English", "whisper": "en", "voices": { "female": "nova", "male": "onyx" } },
  { "code": "de", "name": "German", "whisper": "de", "address": "Always address people formally with \"Sie\", never \"du\"" }
]
```

A language without `voices` uses `VOICE_NAME`.

## Tests

`go test ./internal/speech/...` covers:

- the settings, and the token format the meeting server mints;
- voice detection on the fixtures, and WAV files including streamed ones;
- the engines' requests against a stand-in API, the non-speech filter,
  and passwords kept out of errors;
- a session's edge cases: a speaker switching language, `end`, a failed
  translation (the listener gets the original and a notice), an interim
  for a sentence that has ended, a full queue holding back audio;
- whole streams: a German and an English member at once through the real
  voice detection and protocol with stand-in engines (`ENGINES=fake`:
  numbered transcripts, `[lang] …` translations, a tone for a voice),
  which the browser tests use too, a foreign speaker, and a member's
  second connection.

With real engines:

```bash
SPEECH_SECRET=dev … just speech &
SPEECH_SECRET=dev just speech-test
```

`speech-test` (`cmd/speechcheck`) streams `fixtures/german.wav` and
`fixtures/english.wav` in real time as two members at once, each on its
own connection, and checks that each comes back as subtitles and voice
in the other language.
