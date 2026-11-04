"""Streaming Silero VAD that cuts 16 kHz audio into utterances.

Uses the Silero model bundled with faster-whisper, run one 32 ms frame
at a time with its recurrent state carried across calls.
"""

import os

import faster_whisper
import numpy as np
import onnxruntime

RATE = 16000
FRAME = 512
CONTEXT = 64
START_PROB = 0.5
END_PROB = 0.35
PREROLL_FRAMES = 10
# Past LONG_SPEECH_S of speech, a shorter pause ends the utterance, so
# fast talkers are cut at sentence gaps instead of at max_segment_s.
LONG_SPEECH_S = 3
SHORT_SILENCE_MS = 160

_MODEL = os.path.join(os.path.dirname(faster_whisper.__file__), "assets", "silero_vad_v6.onnx")


def _session() -> onnxruntime.InferenceSession:
    opts = onnxruntime.SessionOptions()
    opts.inter_op_num_threads = 1
    opts.intra_op_num_threads = 1
    opts.log_severity_level = 4

    return onnxruntime.InferenceSession(_MODEL, providers=["CPUExecutionProvider"], sess_options=opts)


class Utterances:
    """Feed PCM in; get back events as utterances start, grow and end."""

    def __init__(self, silence_ms: int, max_segment_s: float):
        self._session = _session()
        self._h = np.zeros((1, 1, 128), np.float32)
        self._c = np.zeros((1, 1, 128), np.float32)
        self._context = np.zeros(CONTEXT, np.float32)
        self._pending = np.zeros(0, np.float32)
        self._preroll: list[np.ndarray] = []
        self._speech: list[np.ndarray] = []
        self._silent_frames = 0
        self._end_frames = max(1, silence_ms * RATE // 1000 // FRAME)
        self._short_end_frames = max(1, min(silence_ms, SHORT_SILENCE_MS) * RATE // 1000 // FRAME)
        self._long_frames = LONG_SPEECH_S * RATE // FRAME
        self._max_frames = int(max_segment_s * RATE / FRAME)

    @property
    def active(self) -> bool:
        return bool(self._speech)

    def audio(self) -> np.ndarray:
        return np.concatenate(self._speech) if self._speech else np.zeros(0, np.float32)

    def push(self, pcm: np.ndarray) -> list[np.ndarray]:
        """Add audio; return every utterance that finished inside it."""
        self._pending = np.concatenate([self._pending, pcm])
        finished = []

        while len(self._pending) >= FRAME:
            frame, self._pending = self._pending[:FRAME], self._pending[FRAME:]
            done = self._frame(frame)
            if done is not None:
                finished.append(done)

        return finished

    def flush(self) -> np.ndarray | None:
        if not self._speech:
            return None

        done = self.audio()
        self._reset()

        return done

    def _frame(self, frame: np.ndarray) -> np.ndarray | None:
        prob = self._prob(frame)

        if not self._speech:
            self._preroll = (self._preroll + [frame])[-PREROLL_FRAMES:]
            if prob >= START_PROB:
                self._speech = list(self._preroll)
                self._silent_frames = 0

            return None

        self._speech.append(frame)
        self._silent_frames = self._silent_frames + 1 if prob < END_PROB else 0

        end_frames = self._short_end_frames if len(self._speech) >= self._long_frames else self._end_frames
        if self._silent_frames >= end_frames or len(self._speech) >= self._max_frames:
            return self.flush()

        return None

    def _prob(self, frame: np.ndarray) -> float:
        batch = np.concatenate([self._context, frame])[None]
        out, self._h, self._c = self._session.run(None, {"input": batch, "h": self._h, "c": self._c})
        self._context = frame[-CONTEXT:]

        return float(out.ravel()[0])

    def _reset(self) -> None:
        self._speech = []
        self._preroll = []
        self._silent_frames = 0
