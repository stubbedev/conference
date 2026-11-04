"""Stream the German and English fixtures through a running speech
service, as two speakers at once, and check that each comes back as
captions and voice in the other language.

SPEECH_SECRET=... python -m tests.stream_sample [ws://localhost:8090]
"""

import asyncio
import json
import os
import sys
import time
import wave
from pathlib import Path

import websockets

from app.auth import mint
from app.framing import pack, unpack

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"
CHUNK = 320  # 20 ms at 16 kHz
SPEAKERS = {"anna": ("de", "german.wav", "en", "female"), "sam": ("en", "english.wav", "de", "male")}
EXPECT = {"anna": ["delivery", "Excel"], "sam": ["Webshop", "Bildschirm"]}


def pcm(name: str) -> bytes:
    with wave.open(str(FIXTURES / name)) as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2
        return w.readframes(w.getnframes())


async def speak(ws, speaker: str, lang: str, voice: str, audio: bytes) -> None:
    audio += bytes(16000 * 2)  # one second of trailing silence
    for i in range(0, len(audio), CHUNK * 2):
        await ws.send(pack({"speaker": speaker, "lang": lang, "voice": voice}, audio[i : i + CHUNK * 2]))
        await asyncio.sleep(0.02)
    await ws.send(json.dumps({"type": "end", "speaker": speaker}))


async def main(url: str) -> int:
    secret = os.environ["SPEECH_SECRET"].encode()

    try:
        async with websockets.connect(f"{url}/v1/stream?token=bogus") as ws:
            await ws.recv()
        print("FAIL: bad token was accepted")
        return 1
    except websockets.InvalidStatus as rejected:
        assert rejected.response.status_code == 403, rejected

    finals: dict[tuple[str, str], list[str]] = {}
    voice: dict[tuple[str, str], float] = {}
    interims = 0
    started = time.perf_counter()

    async with websockets.connect(f"{url}/v1/stream?token={mint(secret, 'test', 'host')}", max_size=None) as ws:
        await ws.send(json.dumps({"type": "hello", "targets": ["en", "de"]}))
        assert json.loads(await ws.recv())["type"] == "ready"

        senders = [
            asyncio.create_task(speak(ws, s, lang, voice, pcm(f))) for s, (lang, f, _, voice) in SPEAKERS.items()
        ]
        while True:
            try:
                message = await asyncio.wait_for(ws.recv(), timeout=10 if all(t.done() for t in senders) else 60)
            except TimeoutError:
                break
            at = time.perf_counter() - started
            if isinstance(message, bytes):
                header, audio = unpack(message)
                voice[(header["speaker"], header["lang"])] = len(audio) / 2 / header["rate"]
                print(f"{at:5.1f}s voice   {header['speaker']} [{header['lang']}] {len(audio) / 2 / header['rate']:.1f}s")
                continue
            caption = json.loads(message)
            if caption.get("type") != "caption":
                continue
            if not caption["final"]:
                interims += 1
                continue
            finals.setdefault((caption["speaker"], caption["lang"]), []).append(caption["text"])
            print(f"{at:5.1f}s caption {caption['speaker']} [{caption['sourceLang']}->{caption['lang']}] {caption['text']}")

    ok = interims > 0
    for speaker, (source, _, target, _) in SPEAKERS.items():
        translated = " ".join(finals.get((speaker, target), []))
        ok &= bool(finals.get((speaker, source)))
        ok &= all(word.lower() in translated.lower() for word in EXPECT[speaker])
        ok &= (speaker, target) in voice
    print(f"\ninterim captions: {interims}")
    print("PASS" if ok else "FAIL")

    return 0 if ok else 1


sys.exit(asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:8090")))
