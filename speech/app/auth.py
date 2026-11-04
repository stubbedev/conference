"""Short-lived room tokens minted by the meeting server.

A token is `<payload>.<signature>`: base64url (unpadded) of the JSON
payload {room, member, exp}, and base64url of HMAC-SHA256 over the
encoded payload with the shared SPEECH_SECRET.
"""

import base64
import hashlib
import hmac
import json
import time


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def mint(secret: bytes, room: str, member: str, ttl_s: int = 3600) -> str:
    payload = _b64(json.dumps({"room": room, "member": member, "exp": int(time.time()) + ttl_s}).encode())
    signature = _b64(hmac.new(secret, payload.encode(), hashlib.sha256).digest())
    return f"{payload}.{signature}"


def verify(secret: bytes, token: str) -> dict | None:
    payload, _, signature = token.partition(".")
    if not payload or not signature:
        return None

    expected = _b64(hmac.new(secret, payload.encode(), hashlib.sha256).digest())
    if not hmac.compare_digest(expected, signature):
        return None

    try:
        claims = json.loads(_unb64(payload))
    except ValueError:
        return None

    if not isinstance(claims, dict) or int(claims.get("exp", 0)) < time.time():
        return None

    return claims
