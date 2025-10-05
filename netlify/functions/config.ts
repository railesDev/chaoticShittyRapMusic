import type { Handler } from '@netlify/functions'

const handler: Handler = async () => {
  const mode = (process.env.CAPTCHA_MODE || 'none').toLowerCase()
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      captcha: mode,
      turnstile_site_key: process.env.TURNSTILE_SITE_KEY || ''
    })
  }
}

export { handler }
