# Speech service

The engine behind live translation: a small Python service (FastAPI) that
each speaking member's browser streams its own microphone to while a host
has live translation switched on. For every finished sentence it sends
back subtitles in the speaker's language and every listener's language,
and a translated voice per listener language. The conference server never
sees any of it; it only hands out the tokens.

```
browser ──16 kHz audio──► voice detection ─► transcription ─► translation ─► voice
        ◄── subtitles, translated voice ──────────────────────────────────────┘
```

No audio or text is logged or written to disk: it lives in memory for as
long as it takes to translate a sentence.

## Run it

```bash
just speech-setup     # once: Python 3.12 venv and the Piper voices
SPEECH_SECRET=s3cret TRANSLATE_URL=http://localhost:11434 TRANSLATE_MODEL=<model> just speech
```

Or in Docker, on a GPU or any CPU:

```bash
cd speech
SPEECH_SECRET=s3cret TRANSLATE_URL=http://ollama:11434 TRANSLATE_MODEL=<model> \
  docker compose --profile gpu up -d   # or --profile local
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
The service also logs a warning at start for every engine that is not set
up or that leaves the network.

## Choosing the AI engines

Each of the three engines has a provider, plus `<ENGINE>_URL`,
`<ENGINE>_API_KEY` and `<ENGINE>_MODEL`. `.env.example` lists every
setting. No engine has a vendor's model as its default.

| Engine | Provider | Where the data goes |
|---|---|---|
| `TRANSCRIBE` | `local` (default): faster-whisper, `WHISPER_MODEL` | this machine |
| | `openai-compatible` | wherever `TRANSCRIBE_URL` points |
| `TRANSLATE` | `ollama` (default): any model Ollama serves | your Ollama server |
| | `openai-compatible` | wherever `TRANSLATE_URL` points |
| `VOICE` | `piper` (default): voices in `languages.yaml` | this machine |
| | `openai-compatible`: `/audio/speech`, `api_voices` in `languages.yaml` | wherever `VOICE_URL` points |

`openai-compatible` is any service with OpenAI's API shape: OpenAI, Azure
OpenAI, Mistral, Groq or OpenRouter, or a server of your own such as vLLM,
LM Studio or speaches. Live subtitles always come from the local Whisper;
an `openai-compatible` transcription engine transcribes finished sentences.
`<ENGINE>_EXTERNAL=true|false` overrides the guess whether an engine is
outside your network.

### What it was tested with

- **Fully local:** Whisper `small` on a Mac CPU,
  `gemma4:26b-a4b-it-qat` on Ollama for translation, and Piper for the
  voices. On an NVIDIA GPU the compose file's `gpu` profile uses Whisper
  `large-v3-turbo` instead.
- **OpenAI:** `gpt-4o-mini` for translation and `gpt-transcribe` for
  transcription, with Piper voices; the voice was also tried with
  `gpt-4o-mini-tts`. This sends the call's audio and text to OpenAI, so
  it suits testing, not confidential calls.

```bash
TRANSCRIBE_PROVIDER=openai-compatible TRANSCRIBE_MODEL=gpt-transcribe \
TRANSLATE_PROVIDER=openai-compatible TRANSLATE_MODEL=gpt-4o-mini \
OPENAI_API_KEY=sk-... SPEECH_SECRET=s3cret just speech
```

## Languages

English, German and Swedish are included. A language is an entry in
`languages.yaml`: a Whisper code, a Piper voice per voice choice (female,
male), optionally a form-of-address rule for the translation (German
"Sie", Swedish "du") and voice names for an `openai-compatible` voice
engine. The conference app takes its language list from here.

## Tests

```bash
just speech-unit                               # engine settings, no models needed
SPEECH_SECRET=dev TRANSLATE_MODEL=<model> just speech &
SPEECH_SECRET=dev just speech-test             # the fixtures through a running service
```

`speech-test` streams `fixtures/german.wav` and `fixtures/english.wav` as
two speakers at once and checks that each comes back as subtitles and
voice in the other language. `ENGINES=fake` swaps all three engines for
stand-ins (numbered transcripts, `[lang] …` translations, a tone for a
voice), which the browser tests use.
