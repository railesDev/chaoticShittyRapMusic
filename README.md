## Anonymous Channel Submissions (Netlify-only: React + Functions)

Simple, production‑ready anonymous submission channel hosted 100% on Netlify:
- Frontend: React (Vite) as static site
- Backend: Netlify Functions (Node) for automatic moderation and Telegram posting
- Anti‑abuse: Turnstile/hCaptcha (optional), honeypot, server checks, signed cookie rate‑limit
- Flow: function validates and posts directly to the channel with a pre‑generated `cu-<id>` prefix (no edits)

### Repo layout
- `web/` — Vite + React SPA
- `netlify/functions/` — Functions: `submit` (POST), `config` (GET)
- `netlify.toml` — Build + function routing (`/api/submit`, `/api/config`)

### Deploy on Netlify
1) Create a Netlify site from this repo (Import from Git)
2) Build picks up from `netlify.toml`:
   - Build command: `npm install && npm run build:web`
   - Publish: `web/dist`
   - Functions: `netlify/functions` (bundler esbuild, Node 20)
3) Set Site Environment variables:
   - `TELEGRAM_BOT_TOKEN` — from @BotFather
   - `TELEGRAM_CHANNEL_ID` — `@channel_username` or numeric ID (bot must be admin)
   - `SIGNING_SECRET` — random string for cookie signing
   - `CAPTCHA_MODE` — `none` to start, later `turnstile` or `hcaptcha`
   - For Turnstile (optional): `TURNSTILE_SITE_KEY` (public), `TURNSTILE_SECRET` (secret)
   - Optional: `MAX_ATTACHMENT_SIZE_MB` (default 6), `RATE_LIMIT_MINUTES` (default 1)
4) Deploy and test on your Netlify domain.

### Branch previews on Netlify + GitHub
- Create a feature branch, e.g. `feature/ui-redesign` and push it to GitHub.
- In Netlify Site settings → Build & deploy → Deploy contexts, enable:
  - Branch deploys for your feature branch (or all non‑production branches)
  - Deploy previews for pull requests
- Open a PR from `feature/ui-redesign` to `main`. Netlify will attach a unique Preview URL to the PR for QA.
- When approved, merge the PR; Netlify promotes the change to your production context at the next deploy.

### Enable Turnstile after domain exists
- Create Turnstile widget, add `<yoursite>.netlify.app` as hostname (and `localhost` for local dev)
- Put keys in Site env: `CAPTCHA_MODE=turnstile`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`
- Redeploy (frontend fetches keys via `/api/config`)

### Local dev
- Frontend only:
```
cd web && npm i
VITE_API_BASE_URL=http://localhost:8888/.netlify/functions npm run dev
```
- Netlify Dev (runs functions locally + proxies):
```
npm i -g netlify-cli
netlify dev
```

### Notes
- Netlify Functions body limit ~6 MB → adjust `MAX_ATTACHMENT_SIZE_MB`
- Add bot as channel admin with permission to post
- Files: images/audio/video/docs allowed; executables blocked; text length <= 4000
