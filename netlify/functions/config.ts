import type { Handler } from '@netlify/functions'

const RATE_LIMIT_MINUTES = parseInt(process.env.RATE_LIMIT_MINUTES || '1', 10)
const RATE_LIMIT_SECONDS_ENV = parseInt(process.env.RATE_LIMIT_SECONDS || '10', 10)
const RATE_WINDOW_SECONDS = Number.isFinite(RATE_LIMIT_SECONDS_ENV) ? RATE_LIMIT_SECONDS_ENV : (RATE_LIMIT_MINUTES * 60)

const handler: Handler = async () => {
  const mode = (process.env.CAPTCHA_MODE || 'turnstile').toLowerCase()
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      captcha: mode,
      turnstile_site_key: process.env.TURNSTILE_SITE_KEY || '',
      rate_limit_seconds: RATE_WINDOW_SECONDS
    })
  }
}

export { handler }
