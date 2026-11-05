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

Voice detection runs in the service itself: the Silero VAD model in pure
Go ([go-silerovad](https://github.com/vithnilica/go-silerovad), MIT), so
the binary is static and needs no cgo, Python or model download.
Transcription, translation and the voice are HTTP engines you choose.

No audio or text is logged or written to disk: it lives in memory for as
long as it takes to translate a sentence.

## Run it

```bash
SPEECH_SECRET=s3cret TRANSCRIBE_MODEL=… TRANSLATE_MODEL=… VOICE_MODEL=… VOICE_NAME=… just speech
```

Or in Docker (build context is the repository root):

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
leaves the network.

## Choosing the engines

`.env.example` lists every setting. No engine has a vendor's model as its
default.

| Engine | API | Settings |
|---|---|---|
| Transcription | OpenAI-compatible `/audio/transcriptions` | `TRANSCRIBE_URL`, `TRANSCRIBE_API_KEY`, `TRANSCRIBE_MODEL` |
| Translation | Ollama `/api/chat` (default) or OpenAI-compatible `/chat/completions` | `TRANSLATE_PROVIDER`, `TRANSLATE_URL`, `TRANSLATE_API_KEY`, `TRANSLATE_MODEL` |
| Voice | OpenAI-compatible `/audio/speech`, raw PCM | `VOICE_URL`, `VOICE_API_KEY`, `VOICE_MODEL`, `VOICE_NAME`, `VOICE_RATE` |

`OPENAI_URL` and `OPENAI_API_KEY` set the address and key for every
OpenAI-compatible engine that doesn't set its own; the address defaults
to OpenAI's. OpenAI-compatible means OpenAI itself, Azure OpenAI,
Mistral, Groq or OpenRouter, or a server of your own:

- **Transcription on your own machine:** whisper.cpp's `whisper-server`
  (C++), started with `--inference-path /v1/audio/transcriptions`.
- **Translation on your own machine:** any model Ollama serves.
- **Voice on your own machine:** any server that speaks OpenAI's
  `/audio/speech` and can return `pcm`; set `VOICE_RATE` to its sample
  rate (OpenAI's is 24000).

Interim subtitles, shown while someone is still talking, transcribe the
growing sentence every `INTERIM_MS` (600 ms). Against a paid API that is
a call per interim; `INTERIM_MS=0` turns them off.

`<ENGINE>_EXTERNAL=true|false` overrides the guess whether an engine is
outside your network (anything but loopback, private and link-local
addresses, bare host names and `.local`, `.internal`, `.lan` names).

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

`go test ./internal/speech/...` covers the settings, the token format the
meeting server mints, voice detection on the fixtures, the engines'
requests against a stand-in API, and the whole stream: German and English
speakers at once through the real voice detection and protocol with
stand-in engines (`ENGINES=fake`: numbered transcripts, `[lang] …`
translations, a tone for a voice), which the browser tests use too.

With real engines:

```bash
SPEECH_SECRET=dev … just speech &
SPEECH_SECRET=dev just speech-test
```

`speech-test` streams `fixtures/german.wav` and `fixtures/english.wav` in
real time as two speakers at once and checks that each comes back as
subtitles and voice in the other language.
