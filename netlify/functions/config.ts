import type { Handler } from '@netlify/functions'
import crypto from 'node:crypto'

const RATE_LIMIT_MINUTES = parseInt(process.env.RATE_LIMIT_MINUTES || '1', 10)
const RATE_LIMIT_SECONDS_ENV = parseInt(process.env.RATE_LIMIT_SECONDS || '10', 10)
const RATE_WINDOW_SECONDS = Number.isFinite(RATE_LIMIT_SECONDS_ENV) ? RATE_LIMIT_SECONDS_ENV : (RATE_LIMIT_MINUTES * 60)
const SIGNING_SECRET = process.env.SIGNING_SECRET || ''

function b64e(buf: Buffer) {
  return buf.toString('base64url')
}
function sign(ts: number) {
  const h = crypto.createHmac('sha256', SIGNING_SECRET)
  h.update(String(ts))
  const sig = b64e(h.digest())
  return `${ts}.${sig}`
}

const handler: Handler = async () => {
  const mode = (process.env.CAPTCHA_MODE || 'turnstile').toLowerCase()
  // Issue a signed cookie upfront so other endpoints can require it. Use a ts in the past
  // to avoid tripping the submit rate limiter on first send.
  const now = Math.floor(Date.now() / 1000)
  const tsPast = now - (RATE_WINDOW_SECONDS + 1)
  const token = SIGNING_SECRET ? sign(tsPast) : ''
  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(token ? { 'set-cookie': `sub_token=${token}; Max-Age=${365*24*60*60}; Path=/; HttpOnly; SameSite=Lax; Secure` } : {})
    },
    body: JSON.stringify({
      captcha: mode,
      turnstile_site_key: process.env.TURNSTILE_SITE_KEY || '',
      rate_limit_seconds: RATE_WINDOW_SECONDS
    })
  }
}

export { handler }
