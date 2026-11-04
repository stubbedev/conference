"""Binary WebSocket frames: 2-byte big-endian header length, a JSON
header, then raw PCM16 little-endian mono samples."""

import json


def pack(header: dict, payload: bytes) -> bytes:
    encoded = json.dumps(header, separators=(",", ":")).encode()

    return len(encoded).to_bytes(2, "big") + encoded + payload


def unpack(frame: bytes) -> tuple[dict, bytes]:
    size = int.from_bytes(frame[:2], "big")

    return json.loads(frame[2 : 2 + size]), frame[2 + size :]
