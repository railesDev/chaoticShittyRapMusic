## Anonymous Channel Submissions (Single Container: React + FastAPI)

Simple, production‑focused setup for an anonymous submission channel:
- Frontend: React (Vite) built and served by the FastAPI container
- Backend: Python FastAPI (Docker) with automated moderation and Telegram posting
- Anti‑abuse: Turnstile/hCaptcha, honeypot, server checks, rate‑limit cookie
- Flow: backend auto‑moderates and posts directly to the channel; message is prefixed with a backend‑generated `cu-<id>` (no edits)

### Repo layout
- `web/` — Vite + React SPA (built during Docker image build)
- `api/` — FastAPI (`POST /api/submit`) and static serving of built SPA
- `netlify.toml` — optional (if you prefer Netlify for the frontend)

### Optional: Frontend (Netlify)
1) Create a Netlify site from this repo
2) Ensure `web` is the base, `web/dist` publish (already in `netlify.toml`)
3) Env vars on Netlify:
   - `VITE_TURNSTILE_SITE_KEY` — Cloudflare Turnstile site key (public)
   - `VITE_API_BASE_URL` — usually `/api` (proxy); for local dev `http://localhost:8000`

### Deployment (single container)
Deploy anywhere cheap (Render/Fly/Railway/VPS). One container serves both API and frontend.

Required env vars:
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_CHANNEL_ID` — target channel id or `@username` (bot must be admin)
- `SIGNING_SECRET` — random string for cookie signing
- Captcha:
  - `CAPTCHA_MODE` — `turnstile` (default), `hcaptcha`, или `none` (для быстрого старта)
  - Для Turnstile: `TURNSTILE_SITE_KEY` (public) и `TURNSTILE_SECRET` (secret)
  - Для hCaptcha: `HCAPTCHA_SECRET` (потребуются правки фронта для виджета)

Optional:
- `ALLOWED_ORIGINS` (default `*`)
- `MAX_ATTACHMENT_SIZE_MB` (default `10`)
- `RATE_LIMIT_MINUTES` (default `1`)

### Local dev
Backend:
```
python -m venv .venv && source .venv/bin/activate
pip install -r api/requirements.txt
export TELEGRAM_BOT_TOKEN=...
export TELEGRAM_CHANNEL_ID=...
export SIGNING_SECRET=another-secret
export TURNSTILE_SECRET=...  # or HCAPTCHA_SECRET=...
uvicorn api.main:app --reload --port 8000
```

Frontend:
```
cd web
npm i
VITE_API_BASE_URL=http://localhost:8000 npm run dev
```

### Deploy single container (Docker)
```
docker build -t anon-cue2a:latest -f api/Dockerfile .
docker run -p 8000:8000 \
  -e TELEGRAM_BOT_TOKEN=... \
  -e TELEGRAM_CHANNEL_ID=... \
  -e SIGNING_SECRET=... \
  -e TURNSTILE_SECRET=... \
  anon-cue2a:latest
```

### Telegram bot permissions
- Add the bot to your channel as an admin with permission to post.

### Notes
- Allowed types: images, audio, video, text, PDFs, office docs; executables/scripts blocked. Max size default 10MB
- Rate limit: 1/min via signed cookie
- Obfuscation: randomized field names + minified build
