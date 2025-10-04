from __future__ import annotations
import os
import time
from typing import Optional
from pathlib import Path

import httpx
from fastapi import FastAPI, File, Form, Header, HTTPException, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature
import orjson

from moderation import basic_text_moderation, file_allowed
from tg import Telegram
from utils import sanitize_text, sign_token, verify_token, generate_cu_id


def env(name: str, default: Optional[str] = None, required: bool = False) -> str:
    v = os.getenv(name, default)
    if required and not v:
        raise RuntimeError(f"Missing env: {name}")
    return v or ''


ALLOWED_ORIGINS = [o.strip() for o in env('ALLOWED_ORIGINS', '*').split(',')]
CAPTCHA_MODE = env('CAPTCHA_MODE', 'turnstile').lower()  # 'turnstile' | 'hcaptcha' | 'none'
TURNSTILE_SECRET = env('TURNSTILE_SECRET')
HCAPTCHA_SECRET = env('HCAPTCHA_SECRET')
TURNSTILE_SITE_KEY = env('TURNSTILE_SITE_KEY', '')  # public site key for frontend
TELEGRAM_BOT_TOKEN = env('TELEGRAM_BOT_TOKEN', required=True)
TG_CHANNEL_ID = env('TELEGRAM_CHANNEL_ID', required=True)
SIGNING_SECRET = env('SIGNING_SECRET', required=True)
MAX_ATTACHMENT_SIZE_MB = int(env('MAX_ATTACHMENT_SIZE_MB', '10'))
RATE_LIMIT_MINUTES = int(env('RATE_LIMIT_MINUTES', '1'))

MAX_BYTES = MAX_ATTACHMENT_SIZE_MB * 1024 * 1024


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'] if ALLOWED_ORIGINS == ['*'] else ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"]
)

STATIC_DIR = Path(os.getenv('STATIC_DIR', '/app/static'))
ASSETS_DIR = STATIC_DIR / 'assets'
if ASSETS_DIR.exists():
    app.mount('/assets', StaticFiles(directory=str(ASSETS_DIR), html=False), name='assets')


async def verify_captcha(token: str) -> bool:
    if CAPTCHA_MODE == 'none':
        return True
    if CAPTCHA_MODE == 'turnstile' and TURNSTILE_SECRET:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post('https://challenges.cloudflare.com/turnstile/v0/siteverify', data={'secret': TURNSTILE_SECRET, 'response': token})
            ok = r.json().get('success')
            return bool(ok)
    if CAPTCHA_MODE == 'hcaptcha' and HCAPTCHA_SECRET:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post('https://hcaptcha.com/siteverify', data={'secret': HCAPTCHA_SECRET, 'response': token})
            ok = r.json().get('success')
            return bool(ok)
    return False


@app.get('/api/config')
async def cfg():
    return {
        'turnstile_site_key': TURNSTILE_SITE_KEY,
        'captcha': CAPTCHA_MODE
    }


@app.post('/api/submit')
async def submit(
    request: Request,
    response: Response,
    m: str = Form(...),
    x_forwarded_for: Optional[str] = Header(None)
):
    # Decode obfuscated field names map
    try:
        import base64, json
        fields = json.loads(base64.b64decode(m).decode())
    except Exception:
        raise HTTPException(status_code=400, detail='Bad fields')

    form = await request.form()

    def get_field(name: str, default=None):
        key = fields.get(name)
        return form.get(key, default)

    token = get_field('token')
    text = get_field('text', '')
    honeypot = get_field('honeypot', '')
    file_field = fields.get('file')
    upload: Optional[UploadFile] = form.get(file_field) if file_field in form else None

    if honeypot:
        raise HTTPException(status_code=400, detail='Invalid form')

    if not token or not await verify_captcha(token):
        raise HTTPException(status_code=400, detail='Captcha failed')

    # Rate limit via signed cookie
    cookie = request.cookies.get('sub_token')
    if cookie:
        ok, why = verify_token(SIGNING_SECRET, cookie, RATE_LIMIT_MINUTES * 60)
        if not ok:
            if why == 'rate limited':
                raise HTTPException(status_code=429, detail='Слишком часто. Подождите немного.')
            # ignore otherwise

    # Basic moderation
    text = (text or '').strip()
    reason = basic_text_moderation(text)
    if reason:
        raise HTTPException(status_code=400, detail=reason)

    # Validate file
    file_meta = None
    if upload and getattr(upload, 'filename', None):
        try:
            content = await upload.read()
            size = len(content)
            mime = upload.content_type or 'application/octet-stream'
            reason = file_allowed(mime, size, MAX_BYTES)
            if reason:
                raise HTTPException(status_code=400, detail=reason)
            file_meta = (mime, size, upload.filename, content)
        finally:
            try:
                await upload.close()
            except Exception:
                pass

    # Prepare Telegram post directly to target channel (auto-moderation only)
    tgbot = Telegram(TELEGRAM_BOT_TOKEN)
    try:
        cu = generate_cu_id()
        caption = sanitize_text(text) if text else None
        if caption:
            caption_to_send = f"{cu}\n\n{caption}"
        else:
            caption_to_send = cu
        if file_meta:
            mime, size, filename, content = file_meta
            if mime.startswith('image/'):
                await tgbot.send_photo(TG_CHANNEL_ID, caption_to_send, content)
            elif mime.startswith('audio/'):
                await tgbot.send_audio(TG_CHANNEL_ID, caption_to_send, content, title=filename or None)
            elif mime.startswith('video/'):
                await tgbot.send_video(TG_CHANNEL_ID, caption_to_send, content)
            else:
                await tgbot.send_document(TG_CHANNEL_ID, caption_to_send, content, filename=filename or 'file')
        else:
            text_to_send = caption_to_send if caption_to_send else cu
            await tgbot.send_text(TG_CHANNEL_ID, text_to_send)
    finally:
        await tgbot.close()

    # Issue new rate-limit cookie
    ts = int(time.time())
    token_signed = sign_token(SIGNING_SECRET, ts)
    response = JSONResponse({'ok': True})
    response.set_cookie('sub_token', token_signed, max_age=365*24*60*60, path='/', secure=True, httponly=True, samesite='Lax')
    return response


    # No webhook endpoints required for auto-moderation
    

@app.get('/health')
async def health():
    return {'ok': True}


def json_dumps(v, *, default=None):
    return orjson.dumps(v, default=default).decode()


# Serve SPA (built React app) from STATIC_DIR if present
@app.get('/')
async def spa_index():
    index_file = STATIC_DIR / 'index.html'
    if index_file.exists():
        return FileResponse(index_file)
    return PlainTextResponse('OK')


@app.get('/{path:path}')
async def spa_fallback(path: str):
    # Let API and assets be handled by their routes
    if path.startswith('api/') or path.startswith('assets/'):
        raise HTTPException(status_code=404)
    index_file = STATIC_DIR / 'index.html'
    if index_file.exists():
        return FileResponse(index_file)
    raise HTTPException(status_code=404)
