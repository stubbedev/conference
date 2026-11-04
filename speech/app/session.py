"""One host connection: per-speaker utterance detection, then
transcribe → translate → speak for every target language."""

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable

import numpy as np

from .config import DEFAULT_VOICE, VOICES, Settings
from .engines import Engines
from .framing import pack
from .vad import RATE, Utterances

log = logging.getLogger("speech")

Send = Callable[[dict | bytes], Awaitable[None]]


class Speaker:
    def __init__(self, speaker_id: str, settings: Settings):
        self.id = speaker_id
        self.lang = ""
        self.voice = DEFAULT_VOICE
        self.utterances = Utterances(settings.silence_ms, settings.max_segment_s)
        self.seg = 0
        self.context: list[str] = []
        self.finals: asyncio.Queue[tuple[int, str, np.ndarray]] = asyncio.Queue()
        self.worker: asyncio.Task | None = None
        self.interim: asyncio.Task | None = None
        self.interim_samples = 0

    def seg_id(self, seg: int) -> str:
        return f"{self.id}-{seg}"


class Session:
    def __init__(self, settings: Settings, engines: Engines, send: Send):
        self._settings = settings
        self._engines = engines
        self._send = send
        self._targets: list[str] = list(settings.languages)
        self._speakers: dict[str, Speaker] = {}
        self._pending_finals = 0

    @property
    def targets(self) -> list[str]:
        return list(self._targets)

    def set_targets(self, targets: list[str]) -> None:
        self._targets = [t for t in targets if t in self._settings.languages]

    def audio(self, speaker_id: str, lang: str, voice: str, pcm: bytes) -> None:
        if lang not in self._settings.languages or not speaker_id:
            return

        speaker = self._speakers.get(speaker_id)
        if speaker is None:
            speaker = self._speakers[speaker_id] = Speaker(speaker_id, self._settings)
            speaker.worker = asyncio.create_task(self._work(speaker))

        if speaker.lang and speaker.lang != lang:
            self._finish(speaker, speaker.utterances.flush())
        speaker.lang = lang
        speaker.voice = voice if voice in VOICES else DEFAULT_VOICE

        samples = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768
        for done in speaker.utterances.push(samples):
            self._finish(speaker, done)

        self._maybe_interim(speaker)

    def end(self, speaker_id: str) -> None:
        speaker = self._speakers.get(speaker_id)
        if speaker:
            self._finish(speaker, speaker.utterances.flush())

    async def close(self) -> None:
        for speaker in self._speakers.values():
            for task in (speaker.worker, speaker.interim):
                if task:
                    task.cancel()

    def _finish(self, speaker: Speaker, audio: np.ndarray | None) -> None:
        if audio is None or len(audio) < RATE // 4:
            return

        self._pending_finals += 1
        speaker.finals.put_nowait((speaker.seg, speaker.lang, audio))
        speaker.seg += 1
        speaker.interim_samples = 0

    def _maybe_interim(self, speaker: Speaker) -> None:
        if not speaker.utterances.active or (speaker.interim and not speaker.interim.done()):
            return
        if self._pending_finals:
            return  # finals first: an interim would only delay them

        audio = speaker.utterances.audio()
        if len(audio) - speaker.interim_samples < self._settings.interim_ms * RATE // 1000:
            return

        speaker.interim_samples = len(audio)
        speaker.interim = asyncio.create_task(self._interim(speaker, speaker.seg, speaker.lang, audio))

    # Interims are transcribed only: translating every growing utterance
    # floods the translation model, and finished sentences queue behind it.
    async def _interim(self, speaker: Speaker, seg: int, lang: str, audio: np.ndarray) -> None:
        try:
            text = await self._engines.transcribe(audio, lang, final=False)
            if not text or speaker.seg != seg:
                return
            await self._caption(speaker, seg, lang, lang, text, final=False)
        except Exception as err:  # noqa: BLE001 — keep the stream alive; never log content
            log.warning("interim failed: %s", type(err).__name__)

    async def _work(self, speaker: Speaker) -> None:
        while True:
            seg, lang, audio = await speaker.finals.get()
            try:
                await self._final(speaker, seg, lang, audio)
            except Exception as err:  # noqa: BLE001
                log.warning("final failed: %s", type(err).__name__)
            finally:
                self._pending_finals -= 1

    async def _final(self, speaker: Speaker, seg: int, lang: str, audio: np.ndarray) -> None:
        started = time.perf_counter()
        text = await self._engines.transcribe(audio, lang)
        asr_ms = (time.perf_counter() - started) * 1000
        if not text:
            return

        await self._caption(speaker, seg, lang, lang, text, final=True)
        context = list(speaker.context)
        speaker.context = (speaker.context + [text])[-5:]

        async def one(target: str) -> None:
            try:
                translated = await self._engines.translate(text, lang, target, context)
            except Exception as err:  # noqa: BLE001 — never log content
                # A sentence is never lost: the listener reads the original.
                log.warning("translation failed, sent the original: %s", type(err).__name__)
                await self._send({"type": "notice", "code": "translation-failed"})
                await self._caption(speaker, seg, lang, target, text, final=True)
                return
            await self._caption(speaker, seg, lang, target, translated, final=True)
            pcm, rate = await self._engines.speak(translated, target, speaker.voice)
            await self._send(pack({"speaker": speaker.id, "segId": speaker.seg_id(seg), "lang": target, "rate": rate}, pcm))

        await asyncio.gather(*(one(target) for target in self._others(lang)))
        log.info(
            "segment audio_s=%.1f asr_ms=%.0f total_ms=%.0f",
            len(audio) / RATE, asr_ms, (time.perf_counter() - started) * 1000,
        )

    def _others(self, lang: str) -> list[str]:
        return [t for t in self._targets if t != lang]

    async def _caption(self, speaker: Speaker, seg: int, source: str, lang: str, text: str, final: bool) -> None:
        await self._send({
            "type": "caption", "speaker": speaker.id, "segId": speaker.seg_id(seg),
            "sourceLang": source, "lang": lang, "text": text, "final": final,
        })
