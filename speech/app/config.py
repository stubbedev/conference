"""Settings from the environment plus the language registry.

Each of the three engines has a provider and the provider's address,
key and model:

  TRANSCRIBE_PROVIDER  local (faster-whisper, default) | openai-compatible
  TRANSLATE_PROVIDER   ollama (default) | openai-compatible
  VOICE_PROVIDER       piper (default) | openai-compatible

with <ENGINE>_URL, <ENGINE>_API_KEY and <ENGINE>_MODEL. "openai-compatible"
is any service with OpenAI's API shape (OpenAI, Azure OpenAI, Mistral,
Groq, OpenRouter, vLLM, LM Studio, speaches, ...). The earlier names
still work: OLLAMA_URL/OLLAMA_MODEL, TRANSLATOR=openai, TRANSCRIBER=openai
and OPENAI_URL/OPENAI_API_KEY/OPENAI_MODEL/OPENAI_TRANSCRIBE_MODEL.

Nothing has a vendor's model as its default: an engine without a model
is reported as not ready (see Engine.problem), the service still starts,
and the conference app shows live translation as unavailable.
"""

import importlib.util
import ipaddress
import os
from dataclasses import dataclass, field, replace
from pathlib import Path
from urllib.parse import urlparse

import yaml

ROOT = Path(__file__).resolve().parent.parent

VOICES = ("female", "male")
DEFAULT_VOICE = "female"
OPENAI_URL = "https://api.openai.com/v1"
OPENAI_COMPATIBLE = "openai-compatible"


@dataclass(frozen=True)
class Language:
    code: str
    name: str
    whisper: str
    voices: dict[str, str]
    address: str = ""
    # Voice names for an openai-compatible VOICE_PROVIDER, by voice choice.
    api_voices: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Engine:
    provider: str
    url: str = ""
    api_key: str = ""
    model: str = ""
    # What has to be set up before this engine works; empty when ready.
    problem: str = ""
    # Whether audio or text sent to this engine leaves this machine's network.
    external: bool = False

    @property
    def ready(self) -> bool:
        return not self.problem


@dataclass(frozen=True)
class Settings:
    secret: bytes
    transcribe: Engine
    translate: Engine
    voice: Engine
    whisper_model: str
    device: str
    compute_type: str
    voices_dir: Path
    voice_rate: int
    silence_ms: int
    max_segment_s: float
    interim_ms: int
    glossary: str
    languages: dict[str, Language]
    # "fake" replaces all three engines with stand-ins, for end-to-end tests.
    engines: str

    def named_engines(self) -> dict[str, Engine]:
        return {"transcription": self.transcribe, "translation": self.translate, "voice": self.voice}

    @property
    def ready(self) -> bool:
        return all(engine.ready for engine in self.named_engines().values())


def _env(*names: str, default: str = "") -> str:
    """The first of these variables that is set."""
    for name in names:
        value = os.environ.get(name, "")
        if value:
            return value
    return default


def is_external(url: str) -> bool:
    """Best guess whether a URL leaves this machine's network: anything but
    loopback, private and link-local addresses, bare host names and
    .local/.internal/.lan names."""
    host = (urlparse(url).hostname or "").lower()
    if not host:
        return False
    if host == "localhost" or host.endswith((".local", ".internal", ".lan")) or "." not in host:
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return True
    return not (address.is_loopback or address.is_private or address.is_link_local)


def _external(engine: str, url: str) -> bool:
    """<ENGINE>_EXTERNAL=true|false overrides the guess, e.g. for an
    internal domain name the guess cannot recognise."""
    override = _env(f"{engine}_EXTERNAL").lower()
    if override in ("true", "false"):
        return override == "true"
    return is_external(url)


def _openai_compatible(engine: str, model_aliases: tuple[str, ...], purpose: str) -> Engine:
    url = _env(f"{engine}_URL", "OPENAI_URL", default=OPENAI_URL).rstrip("/")
    model = _env(f"{engine}_MODEL", *model_aliases)
    return Engine(
        provider=OPENAI_COMPATIBLE,
        url=url,
        api_key=_env(f"{engine}_API_KEY", "OPENAI_API_KEY"),
        model=model,
        problem="" if model else f"set {engine}_MODEL to the {purpose} model to use",
        external=_external(engine, url),
    )


def _transcribe() -> Engine:
    default = OPENAI_COMPATIBLE if _env("TRANSCRIBER") == "openai" else "local"
    provider = _env("TRANSCRIBE_PROVIDER", default=default)
    if provider == OPENAI_COMPATIBLE:
        return _openai_compatible("TRANSCRIBE", ("OPENAI_TRANSCRIBE_MODEL",), "transcription")
    if provider != "local":
        return Engine(provider=provider, problem=f"TRANSCRIBE_PROVIDER must be local or {OPENAI_COMPATIBLE}")
    return Engine(provider="local")


def _translate() -> Engine:
    default = OPENAI_COMPATIBLE if _env("TRANSLATOR") == "openai" else "ollama"
    provider = _env("TRANSLATE_PROVIDER", default=default)
    if provider == OPENAI_COMPATIBLE:
        return _openai_compatible("TRANSLATE", ("OPENAI_MODEL",), "translation")
    if provider != "ollama":
        return Engine(provider=provider, problem=f"TRANSLATE_PROVIDER must be ollama or {OPENAI_COMPATIBLE}")
    url = _env("TRANSLATE_URL", "OLLAMA_URL", default="http://localhost:11434").rstrip("/")
    model = _env("TRANSLATE_MODEL", "OLLAMA_MODEL")
    return Engine(
        provider="ollama",
        url=url,
        model=model,
        problem="" if model else "set TRANSLATE_MODEL to the Ollama model to translate with",
        external=_external("TRANSLATE", url),
    )


def piper_installed() -> bool:
    return importlib.util.find_spec("piper") is not None


def _voice(languages: dict[str, Language], voices_dir: Path) -> Engine:
    provider = _env("VOICE_PROVIDER", default="piper")
    if provider == OPENAI_COMPATIBLE:
        engine = _openai_compatible("VOICE", (), "speech")
        missing = [code for code, lang in languages.items() if not (lang.api_voices or _env("VOICE_NAME"))]
        if engine.ready and missing:
            return replace(engine, problem=f"set api_voices in languages.yaml (or VOICE_NAME) for {', '.join(missing)}")
        return engine
    if provider != "piper":
        return Engine(provider=provider, problem=f"VOICE_PROVIDER must be piper or {OPENAI_COMPATIBLE}")
    if not piper_installed():
        return Engine(provider="piper", problem="Piper is not installed (GPL-3.0, kept separate): pip install piper-tts==1.8.0")
    names = {name for lang in languages.values() for name in lang.voices.values()}
    absent = sorted(name for name in names if not (voices_dir / f"{name}.onnx").exists())
    if absent:
        return Engine(provider="piper", problem=f"Piper voices missing ({', '.join(absent)}): run just speech-setup")
    return Engine(provider="piper")


def load() -> Settings:
    secret = os.environ.get("SPEECH_SECRET", "")
    if not secret:
        raise RuntimeError("SPEECH_SECRET must be set")

    device = os.environ.get("DEVICE", "cpu")
    registry = yaml.safe_load((ROOT / "languages.yaml").read_text())["languages"]
    languages = {code: Language(code=code, **entry) for code, entry in registry.items()}
    voices_dir = Path(os.environ.get("VOICES_DIR", ROOT / "voices"))
    engines = os.environ.get("ENGINES", "real")
    fake = engines == "fake"

    return Settings(
        secret=secret.encode(),
        # Stand-in engines need no provider, so they are always ready.
        transcribe=Engine(provider="fake") if fake else _transcribe(),
        translate=Engine(provider="fake") if fake else _translate(),
        voice=Engine(provider="fake") if fake else _voice(languages, voices_dir),
        whisper_model=os.environ.get("WHISPER_MODEL", "large-v3-turbo" if device == "cuda" else "small"),
        device=device,
        compute_type=os.environ.get("COMPUTE_TYPE", "float16" if device == "cuda" else "int8"),
        voices_dir=voices_dir,
        # Sample rate of an openai-compatible voice's raw PCM (OpenAI's is 24 kHz).
        voice_rate=int(os.environ.get("VOICE_RATE", "24000")),
        silence_ms=int(os.environ.get("SILENCE_MS", "400")),
        max_segment_s=float(os.environ.get("MAX_SEGMENT_S", "12")),
        interim_ms=int(os.environ.get("INTERIM_MS", "600")),
        glossary=os.environ.get("GLOSSARY", ""),
        languages=languages,
        engines=engines,
    )
