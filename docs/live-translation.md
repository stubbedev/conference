# Live translation

Live translation runs on one of two runtimes. By default it runs inside
the conference server, at `/ws/speech` on the server's own address and
TLS: each speaking member's browser streams its own microphone there
while live translation is switched on, and for every finished
sentence it sends back subtitles in the speaker's language and every
listener's language, and a translated voice per listener language.

```
browser ──16 kHz audio──► voice detection ─► transcription ─► translation ─► voice
        ◄── subtitles, translated voice ──────────────────────────────────────┘
```

With `SPEECH_RUNTIME=browser` the same three engines run in every
member's own browser instead, on WebGPU, and no GPU server is needed at
all. See [In the browser](#in-the-browser).

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

The app offers live translation only once all three engines are set up.
Until then the button and the language settings are not shown at all,
because what the server is missing is the operator's business: `/api/config`
names the variables that are still unset. The server logs, at start, every
engine that is not set up or that leaves the network, and whether interim
subtitles are on. Engine URLs are checked at start (http or https, with a
host) and only ever logged with any password hidden.

## Settings

The [`.env.example`](../.env.example) in the repository root lists them
with the rest of the server's settings. No engine has a vendor's model as
its default.

| Setting | Default | |
|---|---|---|
| `SPEECH_RUNTIME` | `server` | `server` runs the engines on this server, `browser` runs them in every member's browser |
| `SPEECH_MODEL_DIR`, `SPEECH_MODELS_FILE` | none | The writable cache of the models the browsers load, and the JSON that names them and lists their files; both are required in browser mode |
| `SPEECH_MODEL_CACHE_MAX` | `15GB` | How much of the model files the cache keeps (`kB`, `MB`, `GB`, `TB`, `KiB`, `MiB`, `GiB`, `TiB`, or bytes) |
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
| `SPEECH_ENGINES` | `real` | `fake` swaps all three engines for stand-ins, for tests, in either runtime |

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

## In the browser

Set `SPEECH_RUNTIME=browser` and every member's browser runs the engines
itself, on WebGPU and WebAssembly, so no GPU server is needed. The server
no longer uses `TRANSCRIBE_*`, `TRANSLATE_*` or `VOICE_*`, and nothing
leaves the member's machine.

The operator gives two settings: `SPEECH_MODEL_DIR`, the directory the
server caches the model files in, and `SPEECH_MODELS_FILE`, a JSON file
naming the exports and the voice for each language, with a manifest of
their files under `files` (left out below):

```json
{
  "asr": {
    "model": "onnx-community/whisper-large-v3-turbo", "dtype": "q4f16",
    "fallback": {
      "model": "onnx-community/whisper-base", "dtype": "q4",
      "languages": { "en": "onnx-community/moonshine-base-ONNX" }
    }
  },
  "mt": {
    "kind": "seq2seq", "model": "Xenova/m2m100_418M", "dtype": "q4f16",
    "pairs": { "en-de": { "model": "Xenova/opus-mt-en-de", "dtype": "q4f16" } },
    "builtin": false
  },
  "tts": { "en": "en_US-joe-medium", "de": "de_DE-thorsten-medium" }
}
```

- **Transcription** (`asr`) is a Whisper model such as
  whisper-large-v3-turbo through transformers.js. `asr.languages` names a
  model a language loads instead of the default one, which is how a room
  with a Danish fine-tune gets one without moving every other language off
  the shared model. `asr.fallback` is the smaller model a browser steps
  down to when it cannot keep up, with its own `languages`: a language
  Moonshine has a model for steps down to it (English, French and
  Ukrainian among these), since its cost follows the length of what was
  said rather than Whisper's fixed 30 seconds.
- **Translation** (`mt`) is a translator (`"kind": "translator"`), a
  language model trained only to translate and prompted with nothing but
  the two languages, such as TranslateGemma; an encoder-decoder model
  (`"kind": "seq2seq"`) such as m2m100; or a general language model
  (`"kind": "llm"`) such as Qwen2.5. Only a general language model follows the translation prompt the
  server runtime uses: the form of address of each language, `GLOSSARY`,
  and the sentences before the one it translates. `mt.pairs` gives a
  language pair, source-target, a smaller model of its own (OPUS-MT), and
  `mt.builtin` lets a browser with a built-in translator (Chrome's
  `Translator`) translate first. With pairs, a translator or
  encoder-decoder `mt.model` is only downloaded by a member who needs a
  pair OPUS-MT does not have.
  The pairs and the built-in translator follow no prompt, so a room that
  needs the glossary or the form of address leaves both out. `mt.fallback`
  names the encoder-decoder model a browser translates with when it cannot
  run the translator or language model on any GPU export, so every member
  translates as well as their machine allows; the fetch script gives both
  m2m100 unless `--mt-fallback` says otherwise.
- **The voice** (`tts`) is a Piper voice per language: the one voice that
  language is spoken in, so the choice between a male and a female voice
  is the operator's, not the speaker's. A language without a voice gets
  subtitles and no voice, and the other engines carry on.

The directory holds each model in the layout transformers.js loads it
from, `<model dir>/<owner>/<model>/config.json` with the export's ONNX
files in `onnx/` beside it, and each voice as `<model dir>/piper/<voice>.onnx`
with `<model dir>/piper/<voice>.onnx.json` beside it. A model a browser
without a usable GPU runs also needs its 8-bit export (`q8`, the
`_quantized` files): every encoder-decoder translation model, the
transcription fallback, and the transcription model itself when there is
no fallback. No single file may be larger than a browser can load, 2 GiB;
a large model splits its weights into `_data`, `_data_1` and onwards.
The server checks at start that the manifest lists every file the
choices need, names the one that is missing or too large, and tells the
browsers what each listed export weighs.

The manifest gives each file the path it is served at, its repository,
the commit to fetch it at, its size and, where the Hub gives one, its
SHA-256 (or a Piper voice's MD5). The model directory is a cache of those
files, not a copy of all of them: the first time a browser asks for a
file, the server fetches it from `huggingface.co` at that commit,
streams it to the browser while it writes it to a temporary file, and
keeps it only once its size and digest match the manifest, so a file that
broke off is never served. Browsers that ask for the same file meanwhile
share that one download. A participant's browser only ever talks to this
server, so no participant's address reaches Hugging Face. A path the
manifest does not list is a 404; the server is no open proxy. A download
that fails, stalls for 30 seconds or cannot connect within 10 seconds
fails the browser's request, which reports it, and nothing is kept; a
rate-limited Hub is waited for as long as its `Retry-After` asks, at
most 330 seconds, four attempts in all.

`SPEECH_MODEL_CACHE_MAX` (15 GB by default) bounds the files the cache
keeps: when a new one does not fit, the one used longest ago that no
browser is reading is deleted. A limit smaller than the largest file in
the manifest stops the server at start, as does a model directory it
cannot write. At start the server takes over the files already in the
directory, so a directory filled by an earlier version is not fetched
again: a file of the size the manifest gives is kept, one of another size
is deleted, and anything the manifest does not list, `models.json`
among it, is left alone and never evicted.

A browser uses the GPU whenever it can. It tries each model on the GPU in
the export `models.json` names, then in every other export of the ladder
in `web/src/lib/speech/runtime.ts` that the manifest lists, skipping those that
need 16-bit floats on a GPU without `shader-f16`. An export counts as
working only once it has run a real inference, and each one that fails is
shown to the member. Transcription walks the ladder for its larger model
and then its smaller one, still on the GPU. The CPU is the last rung, and
a failed download never moves down the ladder, because another export
would fail the same way. A GPU can also hang without failing, as forced
WebGPU does in Firefox on Linux, and a hung worker cannot rescue itself.
So the page watches each GPU attempt and times its longest stretch
without activity. A GPU it has not seen before gets 60 seconds of quiet;
one that has loaded these models before gets four times its longest
earlier stretch, at least 10 seconds. A worker that runs past its budget
is terminated and a new one starts on the CPU. A worker whose GPU refused
every export also starts over on the CPU in a new worker, because a
failed WebGPU run can leave the runtime unable to run even the CPU
export, as WebGPU in Firefox on Linux does. The browser remembers either
in local storage, so later visits start on the CPU at once until the
browser version or the model setup changes.

The models are large: whisper-large-v3-turbo at q4f16 is about 570 MB,
TranslateGemma 4B at q4f16 about 2.7 GB (3.1 GB at q4),
m2m100_418M at q4f16 about 740 MB, Qwen2.5-1.5B-Instruct at q4f16 about 1.2 GB, a
pair about 150 MB, and a Piper medium voice about 60 MB per language. A
browser downloads what it uses once and caches it from then on.

`node web/scripts/fetch-speech-models.mjs` sets that directory up without
the operator looking up a file name: it reads each model's file list from
the Hugging Face API, lists the exports a browser loads, picks a Piper
voice for every language it is given, and writes `models.json`, with the
manifest, for `SPEECH_MODELS_FILE`. It downloads no model; files already
in the directory stay and are used. Mount the directory into the
container writable, since the server caches the files in it (the image
runs as uid 65532, so `chown -R 65532` the host directory), and point
both settings at it.

```sh
node web/scripts/fetch-speech-models.mjs /srv/speech-models --languages=en,de,da
# every language the server speaks (LANGUAGES_FILE, or the built-in list)
node web/scripts/fetch-speech-models.mjs /srv/speech-models --languages=all
# every language, pair models only between English, German and Danish,
# and Chrome's translator first
node web/scripts/fetch-speech-models.mjs /srv/speech-models --languages=all --pair-languages=en,de,da --builtin
# a language model, for the glossary and the form of address
node web/scripts/fetch-speech-models.mjs /srv/speech-models --languages=en,de,da --mt-kind=llm
```

`--asr`, `--asr-dtype`, `--asr-fallback` (or `none`), `--asr-fallback-dtype`,
`--mt`, `--mt-dtype` and `--pair-dtype` choose other models and exports.
The default models are pinned to a commit, so each run lists the same
bytes; a model the script does not pin, such as a pair, is listed at the
commit its repository is on, which the script names, and the server
fetches it at that commit until the script is run again.

OPUS-MT pairs are the default: a pair model in both directions between
each two of `--languages`. `--pair-languages` narrows them to a subset, or
`none` turns them off, while transcription, the voices and the
multilingual model still cover every language in `--languages`. The
multilingual model is TranslateGemma 4B, which translates between any two
of the 35 languages directly, with m2m100 as its fallback; on an RTX 3060
Ti without `shader-f16` its q4 export translated a sentence in about
0.9 s, where m2m100 at q4 dropped clauses. A language model only runs on
the GPU, so a browser without one translates the pairs and m2m100 on the
CPU. Every model also comes with whichever exports of the GPU ladder its
repository has and a browser can hold (4 GiB in all), which is most of
the manifest; with every language and pairs between ten of them it lists
about 52 GB, of which the cache only holds what browsers ask for. A pair is the transformers.js export of
Helsinki-NLP's OPUS-MT model, `Xenova/opus-mt-<source>-<target>` or
else `onnx-community/opus-mt-<source>-<target>`. A pair with neither, or
whose repository lacks the `--pair-dtype` or 8-bit export, is left out of
`models.json` and named on stderr, and the multilingual model translates
it, as it does every pair `models.json` does not list.

Voices are chosen by quality first, medium before high, low and x_low,
and a voice with one speaker before one with several. A voice with
several speakers speaks with the member's choice where they are named
female and male, and with its first one otherwise, as Estonian's and
Serbian's do. Piper has no voice for Belarusian, Bosnian, Croatian,
Macedonian or Maltese, so those get subtitles only; the script says so
and carries on. The Moonshine models for the fallback are found the same
way, by looking for one per language.

A pair with no model of its own is translated by the multilingual model.
Portuguese, Catalan and Romanian reach English through the shared
`Xenova/opus-mt-ROMANCE-en`. The group models that need a target-language
token, such as `gem-gem` and `en-ROMANCE`, are not used: through
transformers.js the token ends up in the translation.

Between English, German and Danish, OPUS-MT has a pair model for every
direction but German to Danish, which m2m100 translates:

| Pair | Model |
|---|---|
| en-de | `Xenova/opus-mt-en-de` |
| de-en | `Xenova/opus-mt-de-en` |
| en-da | `Xenova/opus-mt-en-da` |
| da-en | `Xenova/opus-mt-da-en` |
| da-de | `Xenova/opus-mt-da-de` |
| de-da | none, m2m100 translates it |

Every model and voice file is served from the server's own origin under
`/speech/`, with immutable caching, so nothing comes from a model hub or
CDN at call time. `SPEECH_ENGINES=fake` gives stand-in engines with no
files at all, which the browser tests use.

What moves between browsers is the text of what each member said, sealed
with the room's chat key, exactly as the server runtime's subtitles are.
A room of ten languages therefore costs the speaker nothing extra, and
the translated voice never travels: each listener speaks it on their own
machine.

- **Interim subtitles.** The speaker's browser transcribes a sentence
  again every 600 ms while it is still being said, and shares each
  version; the final one replaces it. A pause that cuts a sentence short
  does not end it: the fragment is shown and held until the sentence
  ends with its full stop, question or exclamation mark, or until 1.5 s
  pass with nothing more said, so it is translated whole.
- **The languages are shared out.** Each browser says how well it can
  translate: with the language model, with an encoder-decoder model, or
  not at all. The room's languages are handed out one at a time, in the
  same order in every browser, each to the member at the best level
  there is who has the fewest languages so far - a member who speaks it
  before one who does not, then the lowest member id. That member
  translates every sentence into it and shares the translation, sealed
  like everything else. So two members with good GPUs split a room of
  six languages between them, one member with the language model serves
  a room of phones on its own, and a listener whose browser cannot
  translate at all still gets every sentence; a member with the language
  model is never passed over for one without it. While a member's
  models load the browsers can briefly disagree on who translates what,
  so a translation into a language is taken from whichever member sends
  it first (the relay checks that it comes from the member it names). A
  browser that has had a sentence, interim or final, for 5 s without any
  translation of it takes that sentence over and translates every
  version of it itself as well as it can, and one that cannot shows it
  as it was said; a translator that goes quiet before a sentence's final
  version is covered the same way. A sentence held for its full stop is
  also let go once it reaches 160 characters, so someone who never pauses
  still gets their sentences finished, translated and spoken.
- **Keeping up.** A browser loads its models when live translation
  starts, not when the first sentence arrives, asks for persistent
  storage, refuses with the size when the models will not fit, and shows
  the download as it goes. Transcription that falls behind, three
  sentences in a row taking longer than they lasted, steps down to
  `asr.fallback` once and says so; a browser without a usable GPU runs
  the fallback on the CPU from the start, so only a server without a
  fallback needs its members to have WebGPU. Whisper's invented
  sentences ("Thank you for watching", subtitle credits, a line repeated
  over and over) are dropped before anyone sees them.
- **The voice** speaks a long translation a clause at a time, starting
  on the first while the rest is still being made.

The web UI carries the pieces every install needs rather than asking for
them: ONNX Runtime's WebAssembly builds, the Silero voice detection
model, and Piper's phonemizer, which together add about 65 MB to the
server binary. `just speech-files` fills `web/public` with them at build
time.

`just e2e-speech` checks the voice detection model in a real browser
against a recording, and `just e2e-translate-browser` runs the whole
pipeline in three browsers on the stand-in engines. `just
e2e-speech-engines <model dir>` runs the built workers on the real
models in a model directory: it transcribes the fixtures, translates
through a pair and the multilingual model, and speaks with every voice.

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

With `SPEECH_RUNTIME=browser` there are no tokens and no streams: the
server never sees a member's speech to translate.

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
