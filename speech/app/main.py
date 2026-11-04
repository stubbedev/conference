"""Speech service: one WebSocket per speaking member's browser.

Client → service: a text frame {"type": "hello", "targets": [...]},
binary audio frames (header {"speaker", "lang", "voice"} + 16 kHz PCM16,
voice being "female" or "male"), and
{"type": "end", "speaker"} when a speaker's stream stops.
Service → client: {"type": "ready"}, caption text frames, a notice
{"type": "notice", "code": "translation-failed"} when a sentence goes out
untranslated, and binary voice frames (header {"speaker", "segId",
"lang", "rate"} + PCM16).

GET /v1/status says, without authentication and without anything secret,
whether every engine is set up, whether any sends data off this network,
and which languages the service speaks. The conference app reads it to
show live translation as available or not.

Privacy: no audio or text is ever logged or written to disk.
"""

import asyncio
import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from . import auth, config
from .engines import Engines, FakeEngines
from .framing import unpack
from .session import Session

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("speech")
for noisy in ("httpx", "httpx2", "faster_whisper"):
    logging.getLogger(noisy).setLevel(logging.WARNING)

# Both sent before accept, so clients see the handshake refused (HTTP 403).
UNAUTHORIZED = 4401
NOT_READY = 4503


def _warn(settings: config.Settings) -> None:
    for purpose, engine in settings.named_engines().items():
        if not engine.ready:
            log.warning("%s is not set up (%s): live translation is unavailable", purpose, engine.problem)
        elif engine.external:
            log.warning(
                "%s goes to an external service (%s at %s): audio or text leaves this network",
                purpose, engine.provider, engine.url,
            )


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.settings = config.load()
    settings = app.state.settings
    app.state.engines = FakeEngines(settings) if settings.engines == "fake" else Engines(settings)
    log.info(
        "started: engines=%s whisper=%s device=%s transcribe=%s translate=%s voice=%s",
        settings.engines, settings.whisper_model, settings.device,
        settings.transcribe.provider, settings.translate.provider, settings.voice.provider,
    )
    _warn(settings)
    yield
    await app.state.engines.close()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}


@app.get("/v1/status")
async def status() -> dict:
    settings: config.Settings = app.state.settings
    return {
        "ready": settings.ready,
        "external": any(engine.external for engine in settings.named_engines().values()),
        "engines": {
            purpose: {
                "provider": engine.provider,
                "model": engine.model,
                "ready": engine.ready,
                "problem": engine.problem,
                "external": engine.external,
            }
            for purpose, engine in settings.named_engines().items()
        },
        "languages": [{"code": lang.code, "name": lang.name} for lang in settings.languages.values()],
    }


@app.websocket("/v1/stream")
async def stream(ws: WebSocket) -> None:
    settings = app.state.settings
    if auth.verify(settings.secret, ws.query_params.get("token", "")) is None:
        await ws.close(code=UNAUTHORIZED)
        return
    if not settings.ready:
        await ws.close(code=NOT_READY)
        return

    await ws.accept()
    lock = asyncio.Lock()

    async def send(message: dict | bytes) -> None:
        async with lock:
            if isinstance(message, bytes):
                await ws.send_bytes(message)
            else:
                await ws.send_text(json.dumps(message))

    session = Session(settings, app.state.engines, send)
    log.info("session opened")
    try:
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes"):
                header, pcm = unpack(message["bytes"])
                session.audio(
                    str(header.get("speaker", "")), str(header.get("lang", "")), str(header.get("voice", "")), pcm
                )
            elif message.get("text"):
                command = json.loads(message["text"])
                if command.get("type") == "hello":
                    session.set_targets(list(command.get("targets", [])))
                    log.info("targets: %s", ",".join(session.targets))
                    await send({"type": "ready"})
                elif command.get("type") == "end":
                    session.end(str(command.get("speaker", "")))
    except WebSocketDisconnect:
        pass
    finally:
        await session.close()
        log.info("session closed")
