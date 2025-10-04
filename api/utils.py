from __future__ import annotations
import base64
import hmac
import time
from hashlib import sha256
from typing import Optional, Tuple
import secrets
import time as _time


def b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip('=')


def b64d(s: str) -> bytes:
    pad = '=' * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def sign_token(secret: str, ts: int) -> str:
    msg = str(ts).encode()
    sig = hmac.new(secret.encode(), msg, sha256).digest()
    return f"{ts}.{b64e(sig)}"


def verify_token(secret: str, token: str, window_seconds: int) -> Tuple[bool, Optional[str]]:
    try:
        ts_str, sig_b64 = token.split('.', 1)
        ts = int(ts_str)
    except Exception:
        return False, 'bad token'
    expected = sign_token(secret, ts)
    if not hmac.compare_digest(expected, token):
        return False, 'bad sig'
    if time.time() - ts < window_seconds:
        return False, 'rate limited'
    return True, None


def sanitize_text(text: str) -> str:
    # Escape HTML for Telegram parse_mode=HTML
    return (
        text.replace('&', '&amp;')
            .replace('<', '&lt;')
            .replace('>', '&gt;')
    )


def _to_base36(n: int) -> str:
    digits = '0123456789abcdefghijklmnopqrstuvwxyz'
    if n == 0:
        return '0'
    s = ''
    while n:
        n, r = divmod(n, 36)
        s = digits[r] + s
    return s


def generate_cu_id() -> str:
    # Short, unique-ish identifier: base36 timestamp + 2 bytes random
    ts36 = _to_base36(int(_time.time()))
    rnd = secrets.token_hex(2)  # 4 hex chars
    return f"cu-{ts36}{rnd}"
