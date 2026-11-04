"""The three engines: transcription (speech → text), translation (text →
text) and voice (text → speech), each on the provider config.Settings
names. One shared instance per process.

Live interim subtitles always come from the local Whisper, which is
loaded whatever the transcription provider; an openai-compatible one
only transcribes finished sentences."""

import asyncio
import io
import os
import wave

import httpx
import numpy as np
from faster_whisper import WhisperModel
from piper import PiperVoice

from .config import DEFAULT_VOICE, OPENAI_COMPATIBLE, Engine, Settings

CONTEXT_SENTENCES = 3
# Past this a sentence is stale; it goes out untranslated instead.
TRANSLATE_TIMEOUT_S = 15


def _client(engine: Engine) -> httpx.AsyncClient:
    headers = {"Authorization": f"Bearer {engine.api_key}"} if engine.api_key else {}
    return httpx.AsyncClient(base_url=engine.url, headers=headers, timeout=TRANSLATE_TIMEOUT_S)


class Engines:
    def __init__(self, settings: Settings):
        self._settings = settings
        self._whisper = WhisperModel(settings.whisper_model, device=settings.device, compute_type=settings.compute_type)
        self._whisper_lock = asyncio.Lock()
        self._voices = (
            {
                (code, choice): PiperVoice.load(str(settings.voices_dir / f"{name}.onnx"))
                for code, lang in settings.languages.items()
                for choice, name in lang.voices.items()
            }
            if settings.voice.provider == "piper" and settings.voice.ready
            else {}
        )
        self._transcribe_http = _client(settings.transcribe)
        self._translate_http = _client(settings.translate)
        self._voice_http = _client(settings.voice)

    async def close(self) -> None:
        for client in (self._transcribe_http, self._translate_http, self._voice_http):
            await client.aclose()

    async def transcribe(self, audio: np.ndarray, lang: str, final: bool = True) -> str:
        whisper_lang = self._settings.languages[lang].whisper
        if final and self._settings.transcribe.provider == OPENAI_COMPATIBLE:
            return await self._transcribe_openai(audio, whisper_lang)

        def run() -> str:
            segments, _ = self._whisper.transcribe(
                audio, language=whisper_lang, beam_size=1, condition_on_previous_text=False, vad_filter=False
            )

            return " ".join(s.text.strip() for s in segments if s.no_speech_prob < 0.6).strip()

        async with self._whisper_lock:
            return await asyncio.to_thread(run)

    async def _transcribe_openai(self, audio: np.ndarray, whisper_lang: str) -> str:
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(16_000)
            out.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())

        response = await self._transcribe_http.post(
            "/audio/transcriptions",
            files={"file": ("speech.wav", buffer.getvalue(), "audio/wav")},
            data={"model": self._settings.transcribe.model, "language": whisper_lang, "response_format": "json"},
        )
        response.raise_for_status()

        return response.json()["text"].strip()

    async def translate(self, text: str, source: str, target: str, context: list[str]) -> str:
        languages = self._settings.languages
        system = (
            f"You translate spoken {languages[source].name} from a business video call into natural spoken "
            f"{languages[target].name}. Reply with the translation only."
        )
        if languages[target].address:
            system += f" {languages[target].address}."
        if self._settings.glossary:
            system += f" Use these term translations: {self._settings.glossary}."
        if context:
            system += " Earlier sentences, for context only: " + " ".join(context[-CONTEXT_SENTENCES:])
        messages = [{"role": "system", "content": system}, {"role": "user", "content": text}]

        if self._settings.translate.provider == OPENAI_COMPATIBLE:
            response = await self._translate_http.post(
                "/chat/completions", json={"model": self._settings.translate.model, "messages": messages}
            )
            response.raise_for_status()

            return response.json()["choices"][0]["message"]["content"].strip()

        response = await self._translate_http.post(
            "/api/chat",
            json={
                "model": self._settings.translate.model,
                "stream": False,
                "think": False,
                "options": {"temperature": 0},
                "messages": messages,
            },
        )
        response.raise_for_status()

        return response.json()["message"]["content"].strip()

    async def speak(self, text: str, lang: str, choice: str) -> tuple[bytes, int]:
        """PCM16 mono audio and its sample rate, in the speaker's chosen voice."""
        if self._settings.voice.provider == OPENAI_COMPATIBLE:
            return await self._speak_openai(text, lang, choice)

        voice = self._voices.get((lang, choice)) or self._voices[(lang, DEFAULT_VOICE)]

        def run() -> tuple[bytes, int]:
            buffer = io.BytesIO()
            with wave.open(buffer, "wb") as out:
                voice.synthesize_wav(text, out)
            buffer.seek(0)
            with wave.open(buffer, "rb") as wav:
                return wav.readframes(wav.getnframes()), wav.getframerate()

        return await asyncio.to_thread(run)

    async def _speak_openai(self, text: str, lang: str, choice: str) -> tuple[bytes, int]:
        voices = self._settings.languages[lang].api_voices
        name = voices.get(choice) or voices.get(DEFAULT_VOICE) or os.environ.get("VOICE_NAME", "")
        response = await self._voice_http.post(
            "/audio/speech",
            json={"model": self._settings.voice.model, "voice": name, "input": text, "response_format": "pcm"},
        )
        response.raise_for_status()

        return response.content, self._settings.voice_rate


class FakeEngines:
    """Stand-ins for the three models (ENGINES=fake), for end-to-end tests
    that exercise everything else (VAD, sessions, the protocol) without
    downloading models or calling a translation service. Transcription
    numbers the utterances, translation prefixes the target language and
    the voice is a short tone."""

    TONE_RATE = 16_000

    def __init__(self, settings: Settings):
        self._settings = settings
        self._utterances = 0

    async def close(self) -> None:
        return None

    async def transcribe(self, audio: np.ndarray, lang: str, final: bool = True) -> str:
        if final:
            self._utterances += 1
        return f"{lang} utterance {self._utterances + (0 if final else 1)}"

    async def translate(self, text: str, source: str, target: str, context: list[str]) -> str:
        return f"[{target}] {text}"

    async def speak(self, text: str, lang: str, choice: str) -> tuple[bytes, int]:
        seconds = 0.4
        t = np.arange(int(self.TONE_RATE * seconds)) / self.TONE_RATE
        tone = (0.2 * np.sin(2 * np.pi * 440 * t) * 32767).astype(np.int16)
        return tone.tobytes(), self.TONE_RATE
