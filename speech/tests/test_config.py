"""Engine settings from the environment: providers, the earlier names,
readiness and the external flag. Needs no models.

python -m tests.test_config
"""

import os
import tempfile
from contextlib import contextmanager
from pathlib import Path

from app import config

NAMES = (
    "SPEECH_SECRET", "ENGINES", "VOICES_DIR", "VOICE_NAME",
    "TRANSCRIBE_PROVIDER", "TRANSCRIBE_URL", "TRANSCRIBE_API_KEY", "TRANSCRIBE_MODEL", "TRANSCRIBE_EXTERNAL",
    "TRANSLATE_PROVIDER", "TRANSLATE_URL", "TRANSLATE_API_KEY", "TRANSLATE_MODEL", "TRANSLATE_EXTERNAL",
    "VOICE_PROVIDER", "VOICE_URL", "VOICE_API_KEY", "VOICE_MODEL", "VOICE_EXTERNAL",
    "TRANSCRIBER", "TRANSLATOR", "OLLAMA_URL", "OLLAMA_MODEL",
    "OPENAI_URL", "OPENAI_API_KEY", "OPENAI_MODEL", "OPENAI_TRANSCRIBE_MODEL",
)


@contextmanager
def environment(voices: bool = True, **values: str):
    saved = {name: os.environ.pop(name) for name in NAMES if name in os.environ}
    with tempfile.TemporaryDirectory() as voices_dir:
        if voices:
            for name in ("en_US-lessac-medium", "en_US-ryan-medium", "de_DE-kerstin-low", "de_DE-thorsten-medium",
                         "sv_SE-lisa-medium", "sv_SE-nst-medium"):
                (Path(voices_dir) / f"{name}.onnx").touch()
        os.environ.update({"SPEECH_SECRET": "s", "VOICES_DIR": voices_dir, **values})
        try:
            yield config.load()
        finally:
            for name in NAMES:
                os.environ.pop(name, None)
            os.environ.update(saved)


def test_defaults_need_a_translation_model() -> None:
    with environment() as settings:
        assert settings.transcribe.provider == "local" and settings.transcribe.ready
        assert settings.voice.provider == "piper" and settings.voice.ready
        assert settings.translate.provider == "ollama"
        assert settings.translate.url == "http://localhost:11434"
        assert not settings.translate.ready and "TRANSLATE_MODEL" in settings.translate.problem
        assert not settings.ready


def test_ollama_with_a_model_is_ready_and_local() -> None:
    with environment(TRANSLATE_MODEL="some-model") as settings:
        assert settings.ready
        assert settings.translate.model == "some-model"
        assert not any(engine.external for engine in settings.named_engines().values())


def test_earlier_ollama_names() -> None:
    with environment(OLLAMA_URL="http://10.0.0.5:11434/", OLLAMA_MODEL="old-model") as settings:
        assert settings.translate.url == "http://10.0.0.5:11434"
        assert settings.translate.model == "old-model"
        assert settings.ready


def test_earlier_openai_names() -> None:
    with environment(
        TRANSLATOR="openai", TRANSCRIBER="openai", OPENAI_API_KEY="k",
        OPENAI_MODEL="chat-model", OPENAI_TRANSCRIBE_MODEL="stt-model",
    ) as settings:
        assert settings.translate.provider == config.OPENAI_COMPATIBLE
        assert settings.transcribe.provider == config.OPENAI_COMPATIBLE
        assert settings.translate.model == "chat-model" and settings.transcribe.model == "stt-model"
        assert settings.translate.url == config.OPENAI_URL and settings.translate.api_key == "k"
        assert settings.translate.external and settings.transcribe.external
        assert settings.ready


def test_openai_compatible_needs_a_model() -> None:
    with environment(TRANSLATE_PROVIDER="openai-compatible", TRANSLATE_API_KEY="k") as settings:
        assert not settings.translate.ready and "TRANSLATE_MODEL" in settings.translate.problem


def test_local_openai_compatible_server_is_not_external() -> None:
    with environment(
        TRANSLATE_PROVIDER="openai-compatible", TRANSLATE_URL="http://localhost:1234/v1", TRANSLATE_MODEL="m",
    ) as settings:
        assert settings.ready and not settings.translate.external


def test_external_override() -> None:
    with environment(
        TRANSLATE_PROVIDER="openai-compatible", TRANSLATE_URL="https://llm.example.com/v1",
        TRANSLATE_MODEL="m", TRANSLATE_EXTERNAL="false",
    ) as settings:
        assert not settings.translate.external
    with environment(TRANSLATE_URL="http://gpu-box:11434", TRANSLATE_MODEL="m", TRANSLATE_EXTERNAL="true") as settings:
        assert settings.translate.external


def test_unknown_provider() -> None:
    with environment(TRANSLATE_MODEL="m", VOICE_PROVIDER="espeak") as settings:
        assert not settings.voice.ready and "VOICE_PROVIDER" in settings.voice.problem


def test_missing_piper_voices() -> None:
    with environment(voices=False, TRANSLATE_MODEL="m") as settings:
        assert not settings.voice.ready and "speech-setup" in settings.voice.problem


def test_openai_compatible_voice_needs_voice_names() -> None:
    with environment(TRANSLATE_MODEL="m", VOICE_PROVIDER="openai-compatible", VOICE_MODEL="tts") as settings:
        assert not settings.voice.ready and "api_voices" in settings.voice.problem
    with environment(
        TRANSLATE_MODEL="m", VOICE_PROVIDER="openai-compatible", VOICE_MODEL="tts", VOICE_NAME="alloy",
    ) as settings:
        assert settings.voice.ready


def test_fake_engines_are_always_ready() -> None:
    with environment(voices=False, ENGINES="fake") as settings:
        assert settings.ready


def test_is_external() -> None:
    for url in ("http://localhost:1", "http://127.0.0.1", "http://192.168.1.2", "http://[::1]:8",
                "http://gpu", "http://box.local", "http://llm.internal", "http://169.254.1.1"):
        assert not config.is_external(url), url
    for url in ("https://api.openai.com/v1", "http://8.8.8.8", "https://llm.example.com"):
        assert config.is_external(url), url


if __name__ == "__main__":
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    for test in tests:
        test()
    print(f"{len(tests)} passed")
