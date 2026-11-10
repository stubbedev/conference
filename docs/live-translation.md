# Live translation

The speech service behind live translation runs inside the conference
server, at `/ws/speech` on the server's own address and TLS. Each
speaking member's browser streams its own microphone there while a host
has live translation switched on. For every finished sentence it sends
back subtitles in the speaker's language and every listener's language,
and a translated voice per listener language.

```
browser ──16 kHz audio──► voice detection ─► transcription ─► translation ─► voice
        ◄── subtitles, translated voice ──────────────────────────────────────┘
```

- **No extra service.** Voice detection runs in the server itself: the
  Silero VAD model in pure Go
  ([go-silerovad](https://github.com/vithnilica/go-silerovad), MIT), so
  the binary still needs no cgo, Python or model download. Transcription,
  translation and the voice are HTTP engines you choose; they can stay on
  plain HTTP on the same machine or network, since only the server talks
  to them.
- **Nothing kept.** No audio or text is logged or written to disk: it
  lives in memory for as long as it takes to translate a sentence.
- **One stream per member.** See [Streams](#streams).
- **35 languages**, each translated with the form of address a business
  call uses. See [Languages](#languages).

## Set it up

Set the engines on the conference server, e.g. with Ollama on the Docker
host (`docker-compose.yml` maps `host.docker.internal` to it):

```bash
TRANSLATE_URL=http://host.docker.internal:11434 TRANSLATE_MODEL=… \
TRANSCRIBE_URL=… TRANSCRIBE_MODEL=… VOICE_URL=… VOICE_MODEL=… VOICE_NAME=… docker compose up -d
```

The app shows live translation greyed out, with what is missing, until
all three engines are set up. The server logs, at start, every engine
that is not set up or that leaves the network, and whether interim
subtitles are on. Engine URLs are checked at start (http or https, with a
host) and only ever logged with any password hidden.

## Settings

The [`.env.example`](../.env.example) in the repository root lists them
with the rest of the server's settings. No engine has a vendor's model as
its default.

| Setting | Default | |
|---|---|---|
| `TRANSCRIBE_URL`, `TRANSCRIBE_API_KEY`, `TRANSCRIBE_MODEL` | OpenAI, `OPENAI_API_KEY`, none | Transcription: an OpenAI-compatible `/audio/transcriptions` |
| `TRANSCRIBE_RESPONSE_FORMAT` | `json` | `verbose_json` drops what Whisper marks as non-speech (below) |
| `INTERIM_MS` | 600, or 0 for an external transcription engine | How often to subtitle a sentence still being spoken; 0 turns it off |
| `TRANSLATE_PROVIDER` | `ollama` | `ollama` (`/api/chat`) or `openai-compatible` (`/chat/completions`) |
| `TRANSLATE_URL`, `TRANSLATE_API_KEY`, `TRANSLATE_MODEL` | `http://localhost:11434` (Ollama) or OpenAI, `OPENAI_API_KEY` (OpenAI-compatible only), none | The translation engine |
| `VOICE_URL`, `VOICE_API_KEY`, `VOICE_MODEL` | OpenAI, `OPENAI_API_KEY`, none | The voice: an OpenAI-compatible `/audio/speech` that returns WAV |
| `VOICE_NAME` | none | The voice for languages without their own `voices` |
| `VOICE_CLONING` | `false` | `true` if the voice engine clones voices from a recording; speakers can then choose their own voice (below) |
| `VOICE_CONVERT_URL`, `VOICE_CONVERT_API_KEY`, `VOICE_CONVERT_MODEL` | none | A voice conversion engine (audio.cpp's `/tasks/run`) that turns the stock voice into the speaker's own; the other way to offer own voice (below). Not together with `VOICE_CLONING` |
| `OPENAI_API_KEY` | none | The key for every OpenAI-compatible engine without its own |
| `INTERNAL_DOMAINS` | none | Domains on your network, e.g. `corp.example.com`, so their engines don't count as external |
| `GLOSSARY` | none | Term translations the translator must use, e.g. `Kontainer = Kontainer` |
| `LANGUAGES_FILE` | built in | Your own language list (below) |
| `SPEECH_ENGINES` | `real` | `fake` swaps all three engines for stand-ins, for tests |

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

## Own voice

With `VOICE_CLONING=true` or a conversion engine (`VOICE_CONVERT_*`), a
speaker can choose **My own voice** instead of the female or male one;
without either the app doesn't offer the option.
Listeners see "AI voice (cloned)" on the tile while it plays, so nobody
mistakes it for the person speaking that language.

**Recorded by the speaker.** With My own voice chosen, the join screen
(and the settings during the call) offers **Record my voice**: the
speaker reads a short, meeting-like text in their speaking language (15 s,
with a question and a livelier sentence for intonation). Every language
the service ships has one, shown before recording so it can be read
through first; a language added in a languages file gets a prompt to talk
freely instead. When live translation starts, their browser sends the recording
to the speech service, which transcribes it and uses it from their first
sentence. Without a recording, or with one under 6 s or without speech,
they are heard in the female voice and asked to record. The voice is
never cloned from what they say in the call, only from a recording they
made on purpose; it is the speaker's own action that turns it on.

**The speaker allows the server.** Making the voice happens on this
meeting's server, so the recording leaves the end-to-end encryption the
call itself has. Recording therefore stays off until the speaker switches
on **Make my voice on this meeting's server**, which says exactly that.
The choice is the speaker's, per device; the host can't make it for
them, and listeners are never asked to record. Switching it off later
stops the recording being sent (and makes the service forget it), and
the speaker is heard in the female voice again.

**Where the voice is, and when it's gone.** It comes only from the
speaker's own microphone.

- *Their browser:* in memory while the page is open; cleared when they
  leave the call or delete it. Only if they switch on **Remember my voice
  on this device** is it also kept in this browser's IndexedDB, for later
  calls, until they delete it or switch that off. Every page load deletes
  any stored copy while that switch is off.
- *The speech service:* in memory for that member's stream only. It is
  dropped when the stream ends, and at once when the speaker deletes it
  or picks a stock voice (the browser sends `forget-voice`). Never logged
  or written to disk.
- *The voice or conversion engine:* gets it inline with each request and
  stores nothing on disk. A cloning engine does keep prepared voices in
  memory, so that it doesn't prepare a voice again for every sentence
  (measured on an M1 Max: 2.2 s per sentence with the cache, 6.5 s
  without). It prepares a voice per language, so switching between two
  listener languages costs that again each time unless both stay cached.
  Recommended:
  - `conditionals_cache_slots` (Chatterbox) or `prompt_cache_slots`
    (VoxCPM2) in the model's `session_options`, set to about the number
    of speakers using their own voice at the same time times the
    languages they are heard in (default 1: two would keep evicting each
    other);
  - `--idle-unload-ms 600000`, so after 10 minutes without a request the
    models, and the prepared voices with them, leave memory;
  - `log_request_body` off, so request bodies aren't logged.

  Set the slots to 0 if no voice may outlive its request at all, at about
  three times the time per sentence.

**Two ways to make it.** Operators pick one:

- *Cloning* (`VOICE_CLONING=true`): the voice engine speaks the
  translation in the speaker's voice directly. The voice engine must
  accept audio.cpp's request fields:

```json
{
  "model": "…", "input": "Guten Morgen …", "response_format": "wav",
  "voice_ref": { "type": "base64", "data": "<WAV, 16 kHz mono>" },
  "reference_text": "what the recording says",
  "language": "de"
}
```

[audio.cpp](https://github.com/0xShug0/audio.cpp)'s `audiocpp_server`
(C++, Apache-2.0) serves voice-cloning models such as VoxCPM2 (Apache-2.0)
and Chatterbox Multilingual (MIT), both covering, among others, Danish,
German, English and Swedish. Cloning is heavier than a stock voice: it
needs a GPU to keep up with a live call. Chatterbox needs `language`: a
German sentence without it comes out garbled.

- *Conversion* (`VOICE_CONVERT_URL`, `VOICE_CONVERT_MODEL`): the stock
  voice speaks the translation as usual, and a voice conversion model
  then makes it sound like the speaker. The stock voice can be any
  engine, the conversion doesn't depend on the language, and it is much
  lighter: on an M1 Max, Chatterbox's conversion with 3 flow steps took
  about 0.9 s per sentence, against about 6 s for cloning the same
  sentence, and listeners couldn't tell the two apart. The service sends:

```json
{
  "model": "…",
  "request": {
    "audio_base64": "<the stock voice, WAV>",
    "voice_ref": { "type": "base64", "data": "<the recording, WAV 16 kHz mono>" }
  }
}
```

  to `/tasks/run` and reads the converted WAV from `audio` (base64) in the
  reply. Set the model's speed in the engine, e.g. audio.cpp's
  `"default_request_options": {"num_inference_steps": "3"}` for
  `chatterbox` with `"task": "vc"`. audio.cpp 0.9.4 needs two small
  changes for this: `voice_ref` taken inline as above (it only takes a
  file path there), and a cache of prepared voices
  (`vc_reference_cache_slots` in the model's `session_options`, default
  1; set it to about the number of speakers using their own voice at the
  same time; 0 turns it off). A cached voice is prepared once instead of
  for every sentence, which saved 0.3–0.4 s per sentence on an M1 Max and
  brought a conversion to about 0.7 s. Like the cloning cache, it lives
  only in memory and goes with `--idle-unload-ms`. If a conversion fails,
  the listener hears the stock voice already made for it.

**Voices only where someone listens.** Each speaker's browser tells the
service which languages someone wants a translated voice in; others get
subtitles only, so no voice is synthesized for nobody. A voice queued more
than 10 s behind is skipped (its subtitle still shows), so a voice engine
that can't keep up doesn't build an ever growing delay. A recorder counts
as listening in their language, since the recording mixes the voices in.

## Streams

The server hands each member a token over the call's signaling
connection while live translation is on, signed with a key it makes
fresh at every start; it admits that member of that room for an hour.
A stream carries only that
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
the server. Each entry has a Whisper language code and, where the
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

- the settings, the status the app shows, and the tokens that admit a member;
- voice detection on the fixtures, and WAV files including streamed ones;
- the engines' requests against a stand-in API, the non-speech filter,
  and passwords kept out of errors;
- a session's edge cases: a speaker switching language, `end`, a failed
  translation (the listener gets the original and a notice), an interim
  for a sentence that has ended, a full queue holding back audio;
- whole streams: a German and an English member at once through the real
  voice detection and protocol with stand-in engines (`SPEECH_ENGINES=fake`:
  numbered transcripts, `[lang] …` translations, a tone for a voice),
  which the browser tests use too, a foreign speaker, and a member's
  second connection, refused tokens and origins, and shutdown.

With real engines:

```bash
TRANSCRIBE_MODEL=… TRANSLATE_MODEL=… VOICE_MODEL=… VOICE_NAME=… just speech-test
```

`speech-test` (`cmd/speechcheck`) runs the speech service on those
engines, streams `fixtures/german.wav` and `fixtures/english.wav` through
it in real time as two members at once, each on its own connection, and
checks that each comes back as subtitles and voice in the other language.
